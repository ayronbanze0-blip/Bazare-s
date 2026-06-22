'use strict';

const { validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, calcFee } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const FEE_LIMIT = parseFloat(process.env.FEE_LIMIT_MT) || 150;
const STATUS_FLOW = ['PENDENTE', 'ACEITE', 'EM_PREPARACAO', 'EM_ENTREGA', 'ENTREGUE', 'CANCELADA'];

// ─── BUYER: Place order ───────────────────────────────────────────
const placeOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { items, buyerName, buyerPhone, address, payment, size, color, notes } = req.body;

  if (!items || !items.length) return badRequest(res, 'Nenhum item na encomenda.');

  try {
    // Validate all items and group by seller
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
      include: { bazar: true }
    });

    if (products.length !== productIds.length)
      return badRequest(res, 'Um ou mais produtos não estão disponíveis.');

    // Check stock
    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      if (!product) return badRequest(res, `Produto ${item.productId} não encontrado.`);
      if (product.stock < item.qty) return badRequest(res, `Stock insuficiente para: ${product.name}`);
      if (item.qty < 1) return badRequest(res, `Quantidade inválida para: ${product.name}`);
    }

    // Group items by seller (one order per seller)
    const sellerGroups = {};
    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      const sid = product.sellerId;
      if (!sellerGroups[sid]) sellerGroups[sid] = { sellerId: sid, bazar: product.bazar, items: [] };
      sellerGroups[sid].items.push({ product, qty: item.qty });
    }

    const createdOrders = [];

    await prisma.$transaction(async (tx) => {
      for (const group of Object.values(sellerGroups)) {
        const subtotal = group.items.reduce((s, i) => s + i.product.price * i.qty, 0);
        const feeRate = group.bazar.feeRate || 2;

        const order = await tx.order.create({
          data: {
            buyerId: req.user.id,
            sellerId: group.sellerId,
            bazarId: group.bazar.id,
            buyerName: buyerName || req.user.name,
            buyerPhone,
            address,
            payment: payment || 'Pagamento na entrega',
            size: size || null,
            color: color || null,
            notes: notes || null,
            subtotal,
            feeRate,
            total: subtotal,
            items: {
              create: group.items.map(i => ({
                productId: i.product.id,
                name: i.product.name,
                price: i.product.price,
                qty: i.qty,
                imageUrl: null
              }))
            }
          },
          include: { items: true }
        });

        // Decrement stock
        for (const i of group.items) {
          await tx.product.update({
            where: { id: i.product.id },
            data: { stock: { decrement: i.qty } }
          });
        }

        createdOrders.push(order);
      }
    });

    // Post-transaction: notifications & emails (non-blocking)
    for (const order of createdOrders) {
      const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
      notifSvc.orderReceived(order.sellerId, order.id, order.items.map(i => i.name).join(', '), order.total);
      if (seller?.email) {
        emailSvc.sendOrderNotificationEmail(seller.email, seller.name, order).catch(() => {});
      }
    }

    logger.info(`[Orders] ${createdOrders.length} order(s) placed by ${req.user.email}`);
    return created(res, { orders: createdOrders }, 'Encomenda realizada com sucesso.');
  } catch (err) {
    logger.error(`[Orders.placeOrder] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: My orders ─────────────────────────────────────────────
const myOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      buyerId: req.user.id,
      ...(status && { status })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, rating: true } },
          review: true
        }
      }),
      prisma.order.count({ where })
    ]);

    return ok(res, { orders, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Orders.myOrders] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Received orders ──────────────────────────────────────
const sellerOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      sellerId: req.user.id,
      ...(status && { status })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          buyer: { select: { id: true, name: true, phone: true } }
        }
      }),
      prisma.order.count({ where })
    ]);

    return ok(res, { orders, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Orders.sellerOrders] ${err.message}`);
    return serverError(res);
  }
};

// ─── Get single order ─────────────────────────────────────────────
const getOne = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        bazar: { select: { id: true, name: true } },
        buyer: { select: { id: true, name: true, phone: true, email: true } },
        seller: { select: { id: true, name: true, phone: true, email: true } },
        review: true,
        transaction: true
      }
    });

    if (!order) return notFound(res, 'Encomenda não encontrada.');
    if (order.buyerId !== req.user.id && order.sellerId !== req.user.id && req.user.role !== 'ADMIN') {
      return forbidden(res);
    }

    return ok(res, { order });
  } catch (err) {
    logger.error(`[Orders.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Update order status ──────────────────────────────────
const updateStatus = async (req, res) => {
  const { status, cancelReason } = req.body;
  if (!status || !STATUS_FLOW.includes(status)) return badRequest(res, 'Estado inválido.');

  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return notFound(res);

    const isSeller = order.sellerId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    const isBuyer = order.buyerId === req.user.id;

    if (!isSeller && !isAdmin && !isBuyer) return forbidden(res);

    // Buyers can only confirm delivery
    if (isBuyer && !isAdmin) {
      if (status !== 'ENTREGUE') return forbidden(res, 'Compradores só podem confirmar entrega.');
      if (order.status !== 'EM_ENTREGA') return badRequest(res, 'Encomenda ainda não está em entrega.');
    }

    // Sellers cannot go backwards in flow (except cancel)
    if (isSeller && !isAdmin && status !== 'CANCELADA') {
      const curIdx = STATUS_FLOW.indexOf(order.status);
      const newIdx = STATUS_FLOW.indexOf(status);
      if (newIdx <= curIdx) return badRequest(res, 'Não é possível retroceder o estado da encomenda.');
    }

    const updateData = {
      status,
      ...(status === 'CANCELADA' && { cancelledAt: new Date(), cancelReason: cancelReason || null }),
      ...(status === 'ENTREGUE' && { deliveredAt: new Date() })
    };

    const updated = await prisma.order.update({ where: { id: order.id }, data: updateData });

    // On ENTREGUE: calculate fee, update bazar, create transaction, bump product sales
    if (status === 'ENTREGUE') {
      const bazar = await prisma.bazar.findUnique({ where: { id: order.bazarId } });
      const fee = calcFee(order.total, bazar?.feeRate || 2);
      const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      const itemsLabel = orderItems.map(i => `${i.name} ×${i.qty}`).join(', ') || order.id;

      await prisma.$transaction([
        prisma.order.update({ where: { id: order.id }, data: { feeAmount: fee } }),
        prisma.bazar.update({
          where: { id: order.bazarId },
          data: { pendingFees: { increment: fee }, totalSales: { increment: order.total } }
        }),
        prisma.transaction.create({
          data: {
            bazarId: order.bazarId,
            orderId: order.id,
            sellerId: order.sellerId,
            type: 'VENDA',
            amount: order.total,
            fee,
            description: `Venda: ${itemsLabel}`
          }
        }),
        // Increment sales count for every product in this order
        ...orderItems.map(i =>
          prisma.product.update({ where: { id: i.productId }, data: { sales: { increment: i.qty } } })
        )
      ]);

      // Check fee limit
      const updatedBazar = await prisma.bazar.findUnique({ where: { id: order.bazarId } });
      if (updatedBazar && updatedBazar.pendingFees >= FEE_LIMIT) {
        notifSvc.feeAlert(order.sellerId, updatedBazar.pendingFees);
        const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
        if (seller) emailSvc.sendFeeAlertEmail(seller.email, seller.name, updatedBazar.pendingFees).catch(() => {});
      }
    }

    // If cancelled: restore stock
    if (status === 'CANCELADA') {
      const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
      for (const item of items) {
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.qty } }
        }).catch(() => {}); // Product might have been deleted
      }
      // Increment buyer cancel count
      await prisma.user.update({
        where: { id: order.buyerId },
        data: { cancelCount: { increment: 1 } }
      }).catch(() => {});
    }

    // Notifications
    const targetId = isBuyer ? order.sellerId : order.buyerId;
    notifSvc.orderStatusChanged(targetId, order.id, status);

    // Email notifications
    const buyer = await prisma.user.findUnique({ where: { id: order.buyerId }, select: { email: true, name: true } });
    if (buyer) emailSvc.sendOrderStatusEmail(buyer.email, buyer.name, order, status).catch(() => {});

    logger.info(`[Orders] Status updated: ${order.id} → ${status} by ${req.user.email}`);
    return ok(res, { order: updated }, `Encomenda ${status.toLowerCase()}.`);
  } catch (err) {
    logger.error(`[Orders.updateStatus] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: Submit review ─────────────────────────────────────────
const submitReview = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { rating, comment } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: { take: 1 } }
    });

    if (!order) return notFound(res, 'Encomenda não encontrada.');
    if (order.buyerId !== req.user.id) return forbidden(res);
    if (order.status !== 'ENTREGUE') return badRequest(res, 'Só pode avaliar encomendas entregues.');
    if (order.rated) return badRequest(res, 'Já avaliou esta encomenda.');

    const productId = order.items[0]?.productId;
    if (!productId) return badRequest(res, 'Produto não encontrado na encomenda.');

    await prisma.$transaction(async (tx) => {
      // Create review
      await tx.review.create({
        data: {
          orderId: order.id,
          productId,
          sellerId: order.sellerId,
          buyerId: req.user.id,
          rating: parseInt(rating),
          comment: comment || null
        }
      });

      // Mark order as rated
      await tx.order.update({ where: { id: order.id }, data: { rated: true } });

      // Recalculate seller rating
      const sellerReviews = await tx.review.findMany({ where: { sellerId: order.sellerId } });
      const avgRating = sellerReviews.reduce((s, r) => s + r.rating, 0) / sellerReviews.length;
      await tx.user.update({
        where: { id: order.sellerId },
        data: { rating: Math.round(avgRating * 10) / 10, ratingCount: sellerReviews.length }
      });

      // Recalculate product rating
      const productReviews = await tx.review.findMany({ where: { productId } });
      const avgProductRating = productReviews.reduce((s, r) => s + r.rating, 0) / productReviews.length;
      await tx.product.update({
        where: { id: productId },
        data: { rating: Math.round(avgProductRating * 10) / 10, ratingCount: productReviews.length }
      });
    });

    notifSvc.push(order.sellerId, {
      type: 'REVIEW',
      title: 'Nova avaliação recebida',
      message: `Recebeu uma avaliação de ${rating} estrela${rating !== 1 ? 's' : ''}.`,
      link: '/profile'
    });

    return created(res, {}, 'Avaliação enviada. Obrigado!');
  } catch (err) {
    logger.error(`[Orders.submitReview] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { placeOrder, myOrders, sellerOrders, getOne, updateStatus, submitReview };
