'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const premiumService = require('../services/premiumService');
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
        orderBy: { createdAt: 'desc' }
      }),
      prisma.announcement.count({ where: { bazarId: bazar.id } })
    ]);

    return ok(res, { announcements, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Announcements.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER (Premium): Post an announcement ──────────────────────
const create = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id) return forbidden(res);

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'Publicar anúncios é exclusivo da Conta Premium.');
    }

    const text = sanitize(req.body.text || '');
    if (!text || text.length < 3) return badRequest(res, 'Escreva algo para publicar.');
    if (text.length > 500) return badRequest(res, 'Máximo de 500 caracteres.');

    let imageUrl = null, imagePublicId = null;
    if (req.file) {
      const up = await uploadSvc.uploadToCloud(req.file.path, 'bazares/announcements');
      if (up.ok) { imageUrl = up.url; imagePublicId = up.publicId; }
    }

    const announcement = await prisma.announcement.create({
      data: { bazarId: bazar.id, sellerId: req.user.id, text, imageUrl, imagePublicId }
    });

    return created(res, { announcement }, 'Anúncio publicado.');
  } catch (err) {
    logger.error(`[Announcements.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER/ADMIN: Delete an announcement ────────────────────────
const remove = async (req, res) => {
  try {
    const announcement = await prisma.announcement.findUnique({ where: { id: req.params.announcementId } });
    if (!announcement) return notFound(res, 'Anúncio não encontrado.');
    if (announcement.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    if (announcement.imagePublicId) {
      uploadSvc.deleteFromCloud(announcement.imagePublicId).catch(() => {});
    }
    await prisma.announcement.delete({ where: { id: announcement.id } });
    return ok(res, {}, 'Anúncio removido.');
  } catch (err) {
    logger.error(`[Announcements.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, create, remove };
