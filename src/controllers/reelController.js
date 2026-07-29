'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const { attachReelEngagement } = require('../services/feedEngagementService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const resolveBazar = (idOrSlug) =>
  prisma.bazar.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });

// ─── PUBLIC: List reels from a bazar ──────────────────────────────
const list = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [reels, total] = await Promise.all([
      prisma.reel.findMany({
        where: { bazarId: bazar.id },
        take, skip,
        orderBy: { createdAt: 'desc' },
        include: { product: { select: { id: true, name: true, slug: true, price: true } } }
      }),
      prisma.reel.count({ where: { bazarId: bazar.id } })
    ]);

    return ok(res, { reels: await attachReelEngagement(reels, req.user?.id), meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Reels.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Global reels feed (mais recentes primeiro) ───────────
// Usado pela página de Reels entre bazares (reels.html junta estes
// vídeos reais aos produtos mais vendidos no mesmo carrossel).
const listGlobal = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [reels, total] = await Promise.all([
      prisma.reel.findMany({
        take, skip,
        orderBy: { createdAt: 'desc' },
        include: {
          bazar: { select: { id: true, name: true, slug: true, logoUrl: true } },
          product: { select: { id: true, name: true, slug: true, price: true } }
        }
      }),
      prisma.reel.count()
    ]);

    return ok(res, { reels: await attachReelEngagement(reels, req.user?.id), meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Reels.listGlobal] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Publicar um Reel (vídeo OU foto) ─────────────────────
const create = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id) return forbidden(res);

    // Um Reel é vídeo OU foto — nunca ambos. Vem em campos multipart
    // separados ('video' / 'image'), consoante o que o vendedor escolher.
    const videoFile = req.files?.video?.[0];
    const imageFile = req.files?.image?.[0];
    if (!videoFile && !imageFile) return badRequest(res, 'O Reel precisa de um vídeo ou uma foto.');

    let productId = null;
    if (req.body.productId) {
      const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
      if (product && product.sellerId === req.user.id) productId = product.id;
    }

    let videoUrl = null, videoPublicId = null, imageUrl = null, imagePublicId = null;
    if (videoFile) {
      const up = await uploadSvc.uploadVideoToCloud(videoFile.path, 'bazares/reels');
      if (!up.ok) return badRequest(res, up.error || 'Falha ao enviar o vídeo.');
      videoUrl = up.url; videoPublicId = up.publicId;
    } else {
      const up = await uploadSvc.uploadToCloud(imageFile.path, 'bazares/reels');
      if (!up.ok) return badRequest(res, 'Falha ao enviar a foto.');
      imageUrl = up.url; imagePublicId = up.publicId;
    }

    const text = (req.body.text || '').trim().slice(0, 500) || null;
    const reel = await prisma.reel.create({
      data: {
        bazarId: bazar.id,
        sellerId: req.user.id,
        videoUrl, videoPublicId, imageUrl, imagePublicId,
        text,
        productId
      },
      include: { product: { select: { id: true, name: true, slug: true, price: true } } }
    });

    return created(res, { reel }, 'Reel publicado!');
  } catch (err) {
    logger.error(`[Reels.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Editar a legenda de um Reel ──────────────────────────
const update = async (req, res) => {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: req.params.reelId } });
    if (!reel) return notFound(res, 'Reel não encontrado.');
    if (reel.sellerId !== req.user.id) return forbidden(res);

    const text = (req.body.text || '').trim().slice(0, 500) || null;
    const updated = await prisma.reel.update({
      where: { id: reel.id },
      data: { text },
      include: { product: { select: { id: true, name: true, slug: true, price: true } } }
    });

    return ok(res, { reel: updated }, 'Reel actualizado.');
  } catch (err) {
    logger.error(`[Reels.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER/ADMIN: Apagar um Reel ─────────────────────────────────
const remove = async (req, res) => {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: req.params.reelId } });
    if (!reel) return notFound(res, 'Reel não encontrado.');
    if (reel.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    if (reel.videoPublicId) uploadSvc.deleteFromCloud(reel.videoPublicId).catch(() => {});
    if (reel.imagePublicId) uploadSvc.deleteFromCloud(reel.imagePublicId).catch(() => {});
    await prisma.reel.delete({ where: { id: reel.id } });
    return ok(res, {}, 'Reel removido.');
  } catch (err) {
    logger.error(`[Reels.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, listGlobal, create, update, remove };
