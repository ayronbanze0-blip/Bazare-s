'use strict';

const { ok, created, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const { attachReelEngagement, attachFollowState } = require('../services/feedEngagementService');
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

    return ok(res, { reels: await attachFollowState(await attachReelEngagement(reels, req.user?.id), req.user?.id), meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Reels.listGlobal] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: obter um Reel individual (para o formulário de edição) ────
const getOne = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    const reel = await prisma.reel.findFirst({
      where: { id: req.params.reelId, bazarId: bazar.id },
      include: { product: { select: { id: true, name: true, slug: true, price: true } } }
    });
    if (!reel) return notFound(res, 'Reel não encontrado.');
    if (reel.sellerId !== req.user.id) return forbidden(res);
    return ok(res, { reel });
  } catch (err) {
    logger.error(`[Reels.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Publicar um Reel (vídeo OU foto) ─────────────────────
const create = async (req, res) => {
  try {
    const bazar = await resolveBazar(req.params.idOrSlug);
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id) return forbidden(res);

    // Um Reel é vídeo OU foto — nunca ambos. O vídeo já vem editado e
    // processado pelo editor de vídeo (Fase 3): em vez de reenviar o
    // ficheiro, o frontend refere o `processedVideoJobId` devolvido
    // por POST /api/media/video/process depois de status=DONE. Fotos
    // continuam a chegar por multipart normal ('image').
    const jobId = req.body.processedVideoJobId;
    const imageFile = req.files?.image?.[0];
    if (!jobId && !imageFile) return badRequest(res, 'O Reel precisa de um vídeo (editado) ou de uma foto.');

    let productId = null;
    if (req.body.productId) {
      const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
      if (product && product.sellerId === req.user.id) productId = product.id;
    }

    let videoUrl = null, videoPublicId = null, imageUrl = null, imagePublicId = null;
    let thumbnailUrl = null, thumbnailPublicId = null, videoDurationSec = null;

    if (jobId) {
      const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
      if (!job || job.userId !== req.user.id) return badRequest(res, 'Vídeo processado não encontrado.');
      if (job.status !== 'DONE') return badRequest(res, 'O vídeo ainda está a ser processado. Aguarda a conclusão antes de publicar.');
      videoUrl = job.resultUrl; videoPublicId = job.resultPublicId;
      thumbnailUrl = job.thumbnailUrl; thumbnailPublicId = job.thumbnailPublicId;
      videoDurationSec = job.durationSec;
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
        thumbnailUrl, thumbnailPublicId, videoDurationSec,
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

// ─── SELLER: Editar um Reel — legenda, produto associado e (só para
// Reels de FOTO) trocar a foto. Trocar o VÍDEO de um Reel não é
// suportado aqui: o vídeo passa sempre pelo editor/processamento
// (ver create() acima) — para trocar o vídeo, apaga o Reel e publica
// de novo. Editar aqui a legenda/foto/produto de um Reel de vídeo
// continua a funcionar normalmente, só o próprio ficheiro de vídeo
// é que fica de fora.
const update = async (req, res) => {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: req.params.reelId } });
    if (!reel) return notFound(res, 'Reel não encontrado.');
    if (reel.sellerId !== req.user.id) return forbidden(res);

    const text = (req.body.text || '').trim().slice(0, 500) || null;
    const data = { text };

    if (req.body.productId !== undefined) {
      if (!req.body.productId) {
        data.productId = null;
      } else {
        const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
        if (product && product.sellerId === req.user.id) data.productId = product.id;
      }
    }

    const imageFile = req.files?.image?.[0];
    if (imageFile) {
      if (reel.videoUrl) return badRequest(res, 'Este Reel tem vídeo — não é possível trocar por uma foto. Apaga e publica de novo.');
      const up = await uploadSvc.uploadToCloud(imageFile.path, 'bazares/reels');
      if (!up.ok) return badRequest(res, 'Falha ao enviar a foto.');
      if (reel.imagePublicId) uploadSvc.deleteFromCloud(reel.imagePublicId).catch(() => {});
      data.imageUrl = up.url;
      data.imagePublicId = up.publicId;
    }

    const updated = await prisma.reel.update({
      where: { id: reel.id },
      data,
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
    if (reel.thumbnailPublicId) uploadSvc.deleteFromCloud(reel.thumbnailPublicId).catch(() => {});
    await prisma.reel.delete({ where: { id: reel.id } });
    return ok(res, {}, 'Reel removido.');
  } catch (err) {
    logger.error(`[Reels.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, listGlobal, getOne, create, update, remove };
