'use strict';

const { ok, created, notFound, badRequest, forbidden, serverError, validationError } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const { validationResult } = require('express-validator');
const { attachEngagement, VALID_TYPES } = require('../services/feedEngagementService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const assertType = (targetType) => VALID_TYPES.includes(targetType);

// ─── GET /api/feed/:targetType/:targetId/engagement ──────────────
// Números de reação/partilha/comentários de UM item — usado fora do
// feed agregado (ex: página do produto), sem precisar de paginar o
// feed inteiro só para saber a contagem de um item.
const engagement = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const [result] = await attachEngagement([{ targetType, targetId }], req.user?.id);
    const { targetType: _t, targetId: _id, ...stats } = result;
    return ok(res, stats);
  } catch (err) {
    logger.error(`[Feed.engagement] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed — página Home ──────────────────────────────────
// v1: produtos em destaque (featuredUntil activo) + anúncios recentes,
// misturados por data. Numa v2 isto passa a incluir também produtos
// novos e anúncios de quem não se segue ainda (descoberta) — fica
// preparado para isso porque já devolve targetType/targetId genéricos.
const list = async (req, res) => {
  try {
    const { page = 1, limit = 15 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [featuredProducts, announcements] = await Promise.all([
      prisma.product.findMany({
        where: { active: true, featuredUntil: { gt: new Date() } },
        orderBy: { featuredUntil: 'desc' },
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } }
        }
      }),
      prisma.announcement.findMany({
        orderBy: { createdAt: 'desc' },
        take: 60,
        include: {
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, isPremium: true } }
        }
      })
    ]);

    let items = [
      ...featuredProducts.map((p) => ({
        targetType: 'PRODUCT', targetId: p.id, createdAt: p.featuredUntil,
        product: p
      })),
      ...announcements.map((a) => ({
        targetType: 'ANNOUNCEMENT', targetId: a.id, createdAt: a.createdAt,
        announcement: a
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = items.length;
    items = items.slice(skip, skip + take);
    items = await attachEngagement(items, req.user?.id);

    return ok(res, { items, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/react ──────────────────
// body: { value: 1 | -1 } — enviar o mesmo valor outra vez remove a
// reação (comportamento "toggle", como Facebook/Instagram).
const react = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const value = parseInt(req.body.value, 10);
    if (![1, -1].includes(value)) return badRequest(res, 'value deve ser 1 ou -1.');

    const existing = await prisma.feedReaction.findUnique({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } }
    });

    if (existing && existing.value === value) {
      await prisma.feedReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await prisma.feedReaction.update({ where: { id: existing.id }, data: { value } });
    } else {
      await prisma.feedReaction.create({ data: { userId: req.user.id, targetType, targetId, value } });
    }

    const counts = await prisma.feedReaction.groupBy({
      by: ['value'], where: { targetType, targetId }, _count: true
    });
    const likeCount = counts.find(c => c.value === 1)?._count || 0;
    const dislikeCount = counts.find(c => c.value === -1)?._count || 0;
    const myReaction = (existing && existing.value === value) ? 0 : value;

    return ok(res, { likeCount, dislikeCount, myReaction });
  } catch (err) {
    logger.error(`[Feed.react] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/share ──────────────────
// Repartilha dentro do próprio feed do Bazares — aparece também no
// feed de quem partilhou (marcado como "sharedByMe" na listagem).
const share = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');

    const exists = targetType === 'PRODUCT'
      ? await prisma.product.findUnique({ where: { id: targetId }, select: { id: true } })
      : targetType === 'ANNOUNCEMENT'
      ? await prisma.announcement.findUnique({ where: { id: targetId }, select: { id: true } })
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');

    await prisma.feedShare.upsert({
      where: { userId_targetType_targetId: { userId: req.user.id, targetType, targetId } },
      update: {},
      create: { userId: req.user.id, targetType, targetId }
    });

    const shareCount = await prisma.feedShare.count({ where: { targetType, targetId } });
    return ok(res, { shared: true, shareCount }, 'Partilhado no teu feed.');
  } catch (err) {
    logger.error(`[Feed.share] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/feed/:targetType/:targetId/comments ────────────────
const listComments = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = targetType === 'PRODUCT'
      ? { productId: targetId }
      : targetType === 'ANNOUNCEMENT'
      ? { announcementId: targetId }
      : { reelId: targetId };

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
      }),
      prisma.comment.count({ where })
    ]);

    return ok(res, { comments, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Feed.listComments] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/feed/:targetType/:targetId/comments ───────────────
const createComment = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const { targetType, targetId } = req.params;
    if (!assertType(targetType)) return badRequest(res, 'Tipo inválido.');

    const exists = targetType === 'PRODUCT'
      ? await prisma.product.findUnique({ where: { id: targetId }, select: { id: true } })
      : targetType === 'ANNOUNCEMENT'
      ? await prisma.announcement.findUnique({ where: { id: targetId }, select: { id: true } })
      : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!exists) return notFound(res, 'Conteúdo não encontrado.');

    const targetField = targetType === 'PRODUCT'
      ? { productId: targetId }
      : targetType === 'ANNOUNCEMENT'
      ? { announcementId: targetId }
      : { reelId: targetId };

    const comment = await prisma.comment.create({
      data: {
        userId: req.user.id,
        text: sanitize(req.body.text),
        ...targetField
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
    });

    return created(res, { comment }, 'Comentário publicado.');
  } catch (err) {
    logger.error(`[Feed.createComment] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/feed/comments/:commentId ────────────────────────
const removeComment = async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.commentId },
      include: {
        product: { select: { sellerId: true } },
        announcement: { select: { sellerId: true } },
        reel: { select: { sellerId: true } }
      }
    });
    if (!comment) return notFound(res, 'Comentário não encontrado.');
    const ownerId = comment.product?.sellerId || comment.announcement?.sellerId || comment.reel?.sellerId;
    const canDelete = comment.userId === req.user.id || ownerId === req.user.id || req.user.role === 'ADMIN';
    if (!canDelete) return forbidden(res, 'Sem permissão para apagar este comentário.');

    await prisma.comment.delete({ where: { id: comment.id } });
    return ok(res, {}, 'Comentário removido.');
  } catch (err) {
    logger.error(`[Feed.removeComment] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, react, share, listComments, createComment, removeComment, engagement };
