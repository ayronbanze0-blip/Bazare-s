'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, badRequest, notFound, serverError } = require('../utils/response');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Get my cart ───────────────────────────────────────────────────
const getCart = async (req, res) => {
  try {
    const items = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: {
        product: {
          include: { images: { take: 1, orderBy: { order: 'asc' } }, bazar: { select: { name: true } } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const validItems = items.filter(i => i.product && i.product.active);
    const total = validItems.reduce((s, i) => s + i.product.price * i.qty, 0);

    return ok(res, { items: validItems, total });
  } catch (err) {
    logger.error(`[Cart.getCart] ${err.message}`);
    return serverError(res);
  }
};

// ─── Add to cart ───────────────────────────────────────────────────
const addItem = async (req, res) => {
  try {
    const { productId, qty = 1 } = req.body;
    if (!productId) return badRequest(res, 'Produto obrigatório.');

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.active) return notFound(res, 'Produto não disponível.');
    if (product.stock < qty) return badRequest(res, `Apenas ${product.stock} unidades disponíveis.`);

    const existing = await prisma.cartItem.findUnique({
      where: { userId_productId: { userId: req.user.id, productId } }
    });

    let item;
    if (existing) {
      const newQty = existing.qty + parseInt(qty);
      if (newQty > product.stock) return badRequest(res, `Apenas ${product.stock} unidades disponíveis.`);
      item = await prisma.cartItem.update({ where: { id: existing.id }, data: { qty: newQty } });
    } else {
      item = await prisma.cartItem.create({ data: { userId: req.user.id, productId, qty: parseInt(qty) } });
    }

    return ok(res, { item }, 'Adicionado ao carrinho.');
  } catch (err) {
    logger.error(`[Cart.addItem] ${err.message}`);
    return serverError(res);
  }
};

// ─── Update quantity ────────────────────────────────────────────────
const updateItem = async (req, res) => {
  try {
    const { qty } = req.body;
    const item = await prisma.cartItem.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return notFound(res);

    if (qty <= 0) {
      await prisma.cartItem.delete({ where: { id: item.id } });
      return ok(res, {}, 'Item removido.');
    }

    const updated = await prisma.cartItem.update({ where: { id: item.id }, data: { qty: parseInt(qty) } });
    return ok(res, { item: updated });
  } catch (err) {
    logger.error(`[Cart.updateItem] ${err.message}`);
    return serverError(res);
  }
};

// ─── Remove item ────────────────────────────────────────────────────
const removeItem = async (req, res) => {
  try {
    const item = await prisma.cartItem.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return notFound(res);
    await prisma.cartItem.delete({ where: { id: item.id } });
    return ok(res, {}, 'Item removido do carrinho.');
  } catch (err) {
    logger.error(`[Cart.removeItem] ${err.message}`);
    return serverError(res);
  }
};

// ─── Clear cart ──────────────────────────────────────────────────────
const clearCart = async (req, res) => {
  try {
    await prisma.cartItem.deleteMany({ where: { userId: req.user.id } });
    return ok(res, {}, 'Carrinho esvaziado.');
  } catch (err) {
    logger.error(`[Cart.clearCart] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { getCart, addItem, updateItem, removeItem, clearCart };
