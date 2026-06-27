'use strict';

// Alias route: POST /reviews
// Frontend calls POST /reviews { orderId, productId, rating, comment }
// Backend logic lives in orderController.submitReview (POST /orders/:id/review)
// This route just re-invokes that same controller with the orderId from the body.

const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const { ok, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

router.post('/', authenticate, async (req, res) => {
  try {
    const { orderId, productId, rating, comment } = req.body;
    if (!orderId) return badRequest(res, 'orderId obrigatório.');
    if (!rating || rating < 1 || rating > 5) return badRequest(res, 'Avaliação deve ser entre 1 e 5.');

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { take: 1 } }
    });

    if (!order) return notFound(res, 'Encomenda não encontrada.');
    if (order.buyerId !== req.user.id) return forbidden(res);
    if (order.status !== 'ENTREGUE') return badRequest(res, 'Só pode avaliar encomendas entregues.');
    if (order.rated) return badRequest(res, 'Já avaliou esta encomenda.');

    const resolvedProductId = productId || order.items[0]?.productId;
    if (!resolvedProductId) return badRequest(res, 'Produto não encontrado na encomenda.');

    await prisma.$transaction(async (tx) => {
      await tx.review.create({
        data: {
          orderId: order.id,
          productId: resolvedProductId,
          sellerId: order.sellerId,
          buyerId: req.user.id,
          rating: parseInt(rating),
          comment: comment || null
        }
      });

      await tx.order.update({ where: { id: order.id }, data: { rated: true } });

      const sellerReviews = await tx.review.findMany({ where: { sellerId: order.sellerId } });
      const avgRating = sellerReviews.reduce((s, r) => s + r.rating, 0) / sellerReviews.length;
      await tx.user.update({
        where: { id: order.sellerId },
        data: { rating: Math.round(avgRating * 10) / 10, ratingCount: sellerReviews.length }
      });

      const productReviews = await tx.review.findMany({ where: { productId: resolvedProductId } });
      const avgProductRating = productReviews.reduce((s, r) => s + r.rating, 0) / productReviews.length;
      await tx.product.update({
        where: { id: resolvedProductId },
        data: { rating: Math.round(avgProductRating * 10) / 10, ratingCount: productReviews.length }
      });
    });

    return ok(res, {}, 'Avaliação enviada com sucesso.');
  } catch (err) {
    logger.error(`[Reviews.create] ${err.message}`);
    return serverError(res);
  }
});

module.exports = router;
