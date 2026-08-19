'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const mentionSvc = require('../services/mentionService');
const { attachDirectEngagement } = require('../services/feedEngagementService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const resolveBazar = (idOrSlug) =>
  prisma.bazar.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });

// ─── PUBLIC: List announcements from a bazar ─────────────────────
const list = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [announcements, total] = await Promise.all([
      prisma.announcement.findMany({
        where: { bazarId: bazar.id },
        take, skip,
        orderBy: { createdAt: 'desc' },
        include: {
          images: { orderBy: { order: 'asc' } },
          mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } },
          product: { select: { id: true, name: true, slug: true, price: true } }
        }
      }),
      prisma.announcement.count({ where: { bazarId: bazar.id } })
    ]);

    // Sem isto, myReaction/likeCount/shareCount/commentCount vinham
    // sempre a zero/vazio — reagir, comentar e ver os números certos
    // nunca funcionava em bazar.html, meufeed.html e anuncios.html
    // (todos usam este mesmo endpoint), mesmo que a reação/comentário
    // estivesse guardado na base de dados.
    const withEngagement = await attachDirectEngagement(announcements, req.user?.id, 'ANNOUNCEMENT');

    return ok(res, { announcements: withEngagement, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Announcements.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: obter um anúncio individual (para o formulário de edição) ──
const getOne = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    const announcement = await prisma.announcement.findFirst({
      where: { id: req.params.announcementId, bazarId: bazar.id },
      include: { images: { orderBy: { order: 'asc' } }, product: { select: { id: true, name: true, slug: true, price: true } } }
    });
    if (!announcement) return notFound(res, 'Anúncio não encontrado.');
    if (announcement.sellerId !== req.user.id) return forbidden(res);
    return ok(res, { announcement });
  } catch (err) {
    logger.error(`[Announcements.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Post an announcement ─────────────────────────────────
const create = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id) return forbidden(res);

    const text = sanitize(req.body.text || '');
    if (!text || text.length < 3) return badRequest(res, 'Escreva algo para publicar.');
    if (text.length > 500) return badRequest(res, 'Máximo de 500 caracteres.');

    // Produto associado (opcional) — só aceita se pertencer mesmo a
    // este vendedor, tal como já acontece nos Reels.
    let productId = null;
    if (req.body.productId) {
      const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
      if (product && product.sellerId === req.user.id) productId = product.id;
    }

    const announcement = await prisma.announcement.create({
      data: { bazarId: bazar.id, sellerId: req.user.id, text, productId }
    });

    // Suporta várias fotos por anúncio (campo multipart "images", até 6).
    let imageUploadErrors = [];
    if (req.files && req.files.length > 0) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/announcements');
      const validImages = uploadResults.filter(r => r.ok);
      imageUploadErrors = uploadResults.filter(r => !r.ok).map(r => r.error);
      if (validImages.length > 0) {
        await prisma.announcementImage.createMany({
          data: validImages.map((r, i) => ({
            announcementId: announcement.id,
            url: r.url,
            publicId: r.publicId,
            order: i
          }))
        });
      }
    }

    const full = await prisma.announcement.findUnique({
      where: { id: announcement.id },
      include: { images: { orderBy: { order: 'asc' } }, mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } }, product: { select: { id: true, name: true, slug: true, price: true } } }
    });

    mentionSvc.syncMentions({
      text,
      authorId: req.user.id,
      authorName: req.user.name,
      announcementId: announcement.id,
      link: `home.html?announcement=${announcement.id}`
    }).catch(() => {});

    return created(
      res,
      { announcement: full, imageUploadErrors: imageUploadErrors.length ? imageUploadErrors : undefined },
      'Anúncio publicado.'
    );
  } catch (err) {
    logger.error(`[Announcements.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Editar um anúncio — texto e/ou fotos ─────────────────
// keepImageIds (JSON, campo de texto multipart): ids das fotos já
// existentes que devem ficar, pela ordem desejada. Fotos existentes
// que NÃO estiverem nessa lista são apagadas (Cloudinary incluído).
// Novas fotos (campo "images", multipart) ficam sempre depois das
// mantidas — mesmo comportamento já usado na edição de produtos.
const update = async (req, res) => {
  try {
    const announcement = await prisma.announcement.findUnique({
      where: { id: req.params.announcementId },
      include: { images: true }
    });
    if (!announcement) return notFound(res, 'Anúncio não encontrado.');
    if (announcement.sellerId !== req.user.id) return forbidden(res);

    const text = sanitize(req.body.text || '');
    if (!text || text.length < 3) return badRequest(res, 'Escreva algo para publicar.');
    if (text.length > 500) return badRequest(res, 'Máximo de 500 caracteres.');

    const data = { text };
    if (req.body.productId !== undefined) {
      if (!req.body.productId) {
        data.productId = null;
      } else {
        const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
        data.productId = (product && product.sellerId === req.user.id) ? product.id : null;
      }
    }

    let imageUploadErrors = [];
    if (req.body.keepImageIds !== undefined) {
      let keepIds = [];
      try { keepIds = JSON.parse(req.body.keepImageIds); } catch (_) { keepIds = []; }
      if (!Array.isArray(keepIds)) keepIds = [];

      const toRemove = announcement.images.filter(img => !keepIds.includes(img.id));
      if (toRemove.length) {
        await prisma.announcementImage.deleteMany({ where: { id: { in: toRemove.map(i => i.id) } } });
        toRemove.forEach(img => { if (img.publicId) uploadSvc.deleteFromCloud(img.publicId).catch(() => {}); });
      }
      // Reordena as que ficaram, respeitando a ordem enviada.
      await Promise.all(keepIds.map((id, i) =>
        prisma.announcementImage.update({ where: { id }, data: { order: i } }).catch(() => {})
      ));

      if (req.files && req.files.length > 0) {
        const total = keepIds.length + req.files.length;
        if (total > 6) return badRequest(res, 'Máximo de 6 fotos por anúncio.');
        const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/announcements');
        const validImages = uploadResults.filter(r => r.ok);
        imageUploadErrors = uploadResults.filter(r => !r.ok).map(r => r.error);
        if (validImages.length > 0) {
          await prisma.announcementImage.createMany({
            data: validImages.map((r, i) => ({
              announcementId: announcement.id,
              url: r.url,
              publicId: r.publicId,
              order: keepIds.length + i
            }))
          });
        }
      }
    }

    const updated = await prisma.announcement.update({
      where: { id: announcement.id },
      data,
      include: { images: { orderBy: { order: 'asc' } }, mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } }, product: { select: { id: true, name: true, slug: true, price: true } } }
    });

    mentionSvc.syncMentions({
      text,
      authorId: req.user.id,
      authorName: req.user.name,
      announcementId: announcement.id,
      link: `home.html?announcement=${announcement.id}`
    }).catch(() => {});

    return ok(res, { announcement: updated, imageUploadErrors: imageUploadErrors.length ? imageUploadErrors : undefined }, 'Anúncio actualizado.');
  } catch (err) {
    logger.error(`[Announcements.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER/ADMIN: Delete an announcement ────────────────────────
const remove = async (req, res) => {
  try {
    const announcement = await prisma.announcement.findUnique({
      where: { id: req.params.announcementId },
      include: { images: true }
    });
    if (!announcement) return notFound(res, 'Anúncio não encontrado.');
    if (announcement.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    if (announcement.imagePublicId) {
      uploadSvc.deleteFromCloud(announcement.imagePublicId).catch(() => {});
    }
    announcement.images.forEach(img => {
      if (img.publicId) uploadSvc.deleteFromCloud(img.publicId).catch(() => {});
    });
    await prisma.announcement.delete({ where: { id: announcement.id } });
    return ok(res, {}, 'Anúncio removido.');
  } catch (err) {
    logger.error(`[Announcements.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, create, update, remove };
