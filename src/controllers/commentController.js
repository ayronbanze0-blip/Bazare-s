'use strict';

const { validationResult } = require('express-validator');
const { ok, created, notFound, forbidden, serverError, validationError } = require('../utils/response');
const { sanitize, paginate, paginateMeta } = require('../utils/helpers');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── PUBLIC: List comments on a product ──────────────────────────
const list = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { productId: req.params.id },
        take, skip,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
      }),
      prisma.comment.count({ where: { productId: req.params.id } })
    ]);

    return ok(res, { comments, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Comments.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── AUTH: Post a comment on a product ───────────────────────────
const create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!product) return notFound(res, 'Produto não encontrado.');

    const comment = await prisma.comment.create({
      data: {
        productId: req.params.id,
        userId: req.user.id,
        text: sanitize(req.body.text)
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true, isPremium: true } } }
    });

    return created(res, { comment }, 'Comentário publicado.');
  } catch (err) {
    logger.error(`[Comments.create] ${err.message}`);
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

module.exports = { list, create, remove };
