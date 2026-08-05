'use strict';

// Alias route: POST /reviews
// Frontend calls POST /reviews { orderId, productId, rating, comment }
// Backend logic lives in orderController.submitReview (POST /orders/:id/review)
// This route just re-invokes that same controller with the orderId from the body.

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { ok, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const logger = require('../utils/logger');

// Singleton partilhado — ver nota em controllers/chatController.js
const prisma = require('../config/database');

router.post('/', authenticate, async (req, res) => {
  try {
    const { orderId, productId, rating, comment, recommend } = req.body;
    if (!orderId) return badRequest(res, 'orderId obrigatório.');
    if (!rating || rating < 1 || rating > 5) return badRequest(res, 'Avaliação deve ser entre 1 e 5.');
    // recommend é opcional: aceita true/false ou "true"/"false" vindo do form.
    const recommendValue = recommend === undefined || recommend === null || recommend === ''
      ? null
      : (recommend === true || recommend === 'true');

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
          recommend: recommendValue,
          comment: comment || null
        }
      });

      await tx.order.update({ where: { id: order.id }, data: { rated: true } });

      const sellerReviews = await tx.review.findMany({ where: { sellerId: order.sellerId } });
      const avgRating = sellerReviews.reduce((s, r) => s + r.rating, 0) / sellerReviews.length;
      const thumbsUp = sellerReviews.filter(r => r.recommend === true).length;
      const thumbsDown = sellerReviews.filter(r => r.recommend === false).length;
      await tx.user.update({
        where: { id: order.sellerId },
        data: {
          rating: Math.round(avgRating * 10) / 10,
          ratingCount: sellerReviews.length,
          thumbsUp,
          thumbsDown
        }
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

// GET /reviews?bazarId=me|<id ou slug>&limit=N
// Frontend chama com bazarId='me' a partir do painel do próprio vendedor
// (my-bazar.html). Aceita também um id/slug de bazar para uso futuro
// noutras páginas (ex.: reviews públicas de uma loja).
router.get('/', authenticate, async (req, res) => {
  try {
    const { bazarId, limit } = req.query;
    if (!bazarId) return badRequest(res, 'bazarId obrigatório.');

    let sellerId;
    if (bazarId === 'me') {
      sellerId = req.user.id;
    } else {
      const bazar = await prisma.bazar.findFirst({
        where: { OR: [{ id: bazarId }, { slug: bazarId }] },
        select: { sellerId: true }
      });
      if (!bazar) return notFound(res, 'Bazar não encontrado.');
      sellerId = bazar.sellerId;
    }

    const take = Math.min(parseInt(limit, 10) || 20, 50);
    const reviews = await prisma.review.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        product: { select: { id: true, name: true } }
      }
    });

    return ok(res, { reviews });
  } catch (err) {
    logger.error(`[Reviews.list] ${err.message}`);
    return serverError(res);
  }
});

module.exports = router;
