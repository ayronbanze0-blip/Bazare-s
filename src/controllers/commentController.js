'use strict';

const { validationResult } = require('express-validator');
const { ok, created, notFound, forbidden, serverError, validationError } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const commentService = require('../services/commentService');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── PUBLIC: List comments on a product ──────────────────────────
// Comentários de topo com respostas embutidas (até 3) e gostos —
// mesma lógica partilhada com os comentários de anúncios/reels.
const list = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const { comments, total } = await commentService.listThreaded({ productId: req.params.id }, req.user?.id, { take, skip });
    return ok(res, { comments, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Comments.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTH: Post a comment on a product ───────────────────────────
// body: { text, parentId? } — parentId = resposta a outro comentário.
const create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, slug: true, bazar: { select: { sellerId: true } } } });
    if (!product) return notFound(res, 'Produto não encontrado.');

    let parentId = null;
    let parentAuthorId = null;
    if (req.body.parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: req.body.parentId }, select: { id: true, parentId: true, userId: true, productId: true } });
      if (!parent || parent.productId !== req.params.id) return notFound(res, 'Comentário original não encontrado.');
      parentId = parent.parentId || parent.id;
      parentAuthorId = parent.userId;
    }

    const comment = await prisma.comment.create({
      data: {
        productId: req.params.id,
        userId: req.user.id,
        text: sanitize(req.body.text),
        parentId
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
    });

    const link = `product.html?id=${product.slug || product.id}`;
    if (parentAuthorId && parentAuthorId !== req.user.id) {
      notifSvc.commentReply(parentAuthorId, req.user.name, req.body.text, link).catch(() => {});
    } else if (!parentAuthorId && product.bazar?.sellerId && product.bazar.sellerId !== req.user.id) {
      notifSvc.commentOnContent(product.bazar.sellerId, req.user.name, req.body.text, link).catch(() => {});
    }

    return created(res, { comment: { ...comment, likeCount: 0, likedByMe: false, replies: [] } }, 'Comentário publicado.');
  } catch (err) {
    logger.error(`[Comments.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/products/:id/comments/:commentId/replies ───────────
const listReplies = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const { replies, total } = await commentService.listReplies(req.params.commentId, req.user?.id, { take, skip });
    return ok(res, { replies, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Comments.listReplies] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/products/:id/comments/:commentId/like ─────────────
const like = async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId }, select: { id: true } });
    if (!comment) return notFound(res, 'Comentário não encontrado.');
    const result = await commentService.toggleLike(req.params.commentId, req.user.id);
    return ok(res, result);
  } catch (err) {
    logger.error(`[Comments.like] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTH: Delete a comment ───────────────────────────────────────
// Pode apagar: o autor do comentário, o vendedor dono do produto, ou um admin.
const remove = async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.commentId },
      include: { product: { select: { sellerId: true } } }
    });
    if (!comment) return notFound(res, 'Comentário não encontrado.');

    const canDelete = comment.userId === req.user.id ||
      comment.product.sellerId === req.user.id ||
      req.user.role === 'ADMIN';
    if (!canDelete) return forbidden(res);

    await prisma.comment.delete({ where: { id: comment.id } });
    return ok(res, {}, 'Comentário removido.');
  } catch (err) {
    logger.error(`[Comments.remove] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, create, remove, listReplies, like };
