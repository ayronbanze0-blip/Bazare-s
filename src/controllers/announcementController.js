'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
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
        include: { images: { orderBy: { order: 'asc' } } }
      }),
      prisma.announcement.count({ where: { bazarId: bazar.id } })
    ]);

    return ok(res, { announcements, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Announcements.list] ${err.message}`);
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

    const announcement = await prisma.announcement.create({
      data: { bazarId: bazar.id, sellerId: req.user.id, text }
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
      include: { images: { orderBy: { order: 'asc' } } }
    });

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

module.exports = { list, create, remove };
