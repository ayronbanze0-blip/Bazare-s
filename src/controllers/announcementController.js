'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const mentionSvc = require('../services/mentionService');
const { attachDirectEngagement } = require('../services/feedEngagementService');
const { shapePoll, attachPollToAnnouncements } = require('../services/pollService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const resolveBazar = (idOrSlug) =>
  prisma.bazar.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });

// ─── PUBLIC: List announcements from a bazar ─────────────────────
const list = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (!bazar.active) return notFound(res, 'Bazar não encontrado.');

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
          product: { select: { id: true, name: true, slug: true, price: true } },
          poll: true
        }
      }),
      prisma.announcement.count({ where: { bazarId: bazar.id } })
    ]);

    // Sem isto, myReaction/likeCount/shareCount/commentCount vinham
    // sempre a zero/vazio — reagir, comentar e ver os números certos
    // nunca funcionava em bazar.html, meufeed.html e anuncios.html
    // (todos usam este mesmo endpoint), mesmo que a reação/comentário
    // estivesse guardado na base de dados.
    let withEngagement = await attachDirectEngagement(announcements, req.user?.id, 'ANNOUNCEMENT');
    withEngagement = await attachPollToAnnouncements(withEngagement, req.user?.id);

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
      include: { images: { orderBy: { order: 'asc' } }, product: { select: { id: true, name: true, slug: true, price: true } }, poll: { include: { options: true } } }
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
    if (!bazar.active) return forbidden(res, 'O seu Bazar está inactivo.');

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

    // Fundo de post de texto (estilo Facebook) — só faz sentido sem
    // fotos. Se vierem fotos no mesmo pedido, o fundo é ignorado (a
    // foto tem prioridade visual, como no Facebook/Instagram).
    let backgroundId = null;
    if (req.body.backgroundId && !(req.files && req.files.length > 0)) {
      const n = parseInt(req.body.backgroundId, 10);
      if (n >= 1 && n <= 8) backgroundId = n;
    }

    // Sondagem (opcional) — vem como JSON no campo "poll":
    // { options:["Sim","Não"], allowMultiple:false, durationDays:3 }
    // 2 a 4 opções, texto de 1-80 caracteres cada; um Post só pode ter
    // uma sondagem (mesma ideia do produto associado: opcional, única).
    let pollPayload = null;
    if (req.body.poll) {
      try { pollPayload = JSON.parse(req.body.poll); } catch (_) { pollPayload = null; }
      if (pollPayload) {
        const opts = (pollPayload.options || []).map(o => sanitize(String(o || '')).slice(0, 80)).filter(Boolean);
        if (opts.length < 2 || opts.length > 4) return badRequest(res, 'Uma sondagem precisa de 2 a 4 opções.');
        pollPayload.options = opts;
      }
    }

    const announcement = await prisma.announcement.create({
      data: { bazarId: bazar.id, sellerId: req.user.id, text, productId, backgroundId }
    });

    if (pollPayload) {
      const days = parseInt(pollPayload.durationDays, 10);
      const expiresAt = (days > 0 && days <= 30) ? new Date(Date.now() + days * 86400000) : null;
      await prisma.poll.create({
        data: {
          announcementId: announcement.id,
          allowMultiple: !!pollPayload.allowMultiple,
          expiresAt,
          options: { create: pollPayload.options.map((text, order) => ({ text, order })) }
        }
      });
    }

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
      include: { images: { orderBy: { order: 'asc' } }, mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } }, product: { select: { id: true, name: true, slug: true, price: true } }, poll: true }
    });
    if (full.poll) full.poll = await shapePoll(full.poll, req.user.id);

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
    // Fundo de texto: só aceite explicitamente quando enviado; enviar
    // `backgroundId: ""` limpa o fundo (ex.: o vendedor acabou de
    // adicionar uma foto a um post que era só texto).
    if (req.body.backgroundId !== undefined) {
      if (!req.body.backgroundId) {
        data.backgroundId = null;
      } else {
        const n = parseInt(req.body.backgroundId, 10);
        data.backgroundId = (n >= 1 && n <= 8) ? n : null;
      }
    }
    if (req.body.productId !== undefined) {
      if (!req.body.productId) {
        data.productId = null;
      } else {
        const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
        data.productId = (product && product.sellerId === req.user.id) ? product.id : null;
      }
    }

    let imageUploadErrors = [];
    let keepIds = null;
    if (req.body.keepImageIds !== undefined) {
      try { keepIds = JSON.parse(req.body.keepImageIds); } catch (_) { keepIds = []; }
      if (!Array.isArray(keepIds)) keepIds = [];

      const toRemove = announcement.images.filter(img => !keepIds.includes(img.id));
      if (toRemove.length) {
        await prisma.announcementImage.deleteMany({ where: { id: { in: toRemove.map(i => i.id) } } });
        toRemove.forEach(img => { if (img.publicId) uploadSvc.deleteFromCloud(img.publicId).catch(() => {}); });
      }
      // Reordena as que ficaram, respeitando a ordem enviada. `updateMany`
      // com `announcementId: announcement.id` no where garante que um
      // imageId de OUTRO anúncio (adivinhado/copiado por outro vendedor)
      // nunca é alterado por este pedido — antes usava `update({where:{id}})`
      // sem esse âmbito, o que permitia mexer no `order` de imagens alheias.
      await Promise.all(keepIds.map((id, i) =>
        prisma.announcementImage.updateMany({
          where: { id, announcementId: announcement.id },
          data: { order: i }
        }).catch(() => {})
      ));
    }

    // Processa novas imagens SEMPRE que vierem no pedido — antes só
    // acontecia dentro do `if (keepImageIds !== undefined)`, por isso
    // enviar novas fotos sem enviar keepImageIds fazia o Multer receber
    // os ficheiros e o backend simplesmente ignorá-los (nunca chegavam
    // ao Cloudinary/BD). uploadToCloud/uploadMany já apagam o ficheiro
    // temporário do disco depois do upload (sucesso ou falha).
    if (req.files && req.files.length > 0) {
      const currentCount = keepIds !== null ? keepIds.length : announcement.images.length;
      const total = currentCount + req.files.length;
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
            order: currentCount + i
          }))
        });
        // Uma foto nova chegou e o pedido não disse nada sobre o fundo
        // — limpa o fundo de texto antigo para a foto não ficar
        // escondida atrás dele.
        if (req.body.backgroundId === undefined) data.backgroundId = null;
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
