'use strict';


const { ok, badRequest, notFound, serverError } = require('../utils/response');
const logger = require('../utils/logger');

const prisma = require('../config/database');

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

    // Faltava validar isto — sem esta linha, dava para enviar qty=-5 (ou
    // 0, ou "abc") e criar uma linha de carrinho inválida: `product.stock
    // < qty` nunca apanha quantidades negativas (qualquer stock é "maior"
    // que um número negativo), e um qty não-numérico vira NaN só lá
    // adiante, no create, como erro 500 em vez de um 400 claro.
    const qtyNum = parseInt(qty, 10);
    if (!Number.isInteger(qtyNum) || qtyNum < 1) {
      return badRequest(res, 'Quantidade inválida.');
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.active) return notFound(res, 'Produto não disponível.');
    if (product.stock < qtyNum) return badRequest(res, `Apenas ${product.stock} unidades disponíveis.`);

    const existing = await prisma.cartItem.findUnique({
      where: { userId_productId: { userId: req.user.id, productId } }
    });

    let item;
    if (existing) {
      const newQty = existing.qty + qtyNum;
      if (newQty > product.stock) return badRequest(res, `Apenas ${product.stock} unidades disponíveis.`);
      item = await prisma.cartItem.update({ where: { id: existing.id }, data: { qty: newQty } });
    } else {
      try {
        item = await prisma.cartItem.create({ data: { userId: req.user.id, productId, qty: qtyNum } });
      } catch (createErr) {
        // P2002: um pedido concorrente (duplo toque em "Adicionar") já
        // criou a mesma linha entre a verificação acima e este create —
        // soma a quantidade à linha que venceu a corrida em vez de falhar.
        if (createErr.code !== 'P2002') throw createErr;
        const winner = await prisma.cartItem.findUnique({
          where: { userId_productId: { userId: req.user.id, productId } }
        });
        item = await prisma.cartItem.update({
          where: { id: winner.id },
          data: { qty: winner.qty + qtyNum }
        });
      }
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
    if (qty === undefined || qty === null || isNaN(parseInt(qty))) {
      return badRequest(res, 'Quantidade inválida.');
    }
    const item = await prisma.cartItem.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return notFound(res);

    if (qty <= 0) {
      await prisma.cartItem.delete({ where: { id: item.id } });
      return ok(res, {}, 'Item removido.');
    }

    // Mesma validação de stock que já existe em addItem — faltava aqui,
    // por isso dava para pôr uma quantidade acima do stock disponível
    // só editando a linha existente do carrinho (só era apanhado mais
    // tarde, ao finalizar a encomenda).
    const product = await prisma.product.findUnique({ where: { id: item.productId } });
    if (!product || !product.active) return notFound(res, 'Produto não disponível.');
    if (parseInt(qty) > product.stock) return badRequest(res, `Apenas ${product.stock} unidades disponíveis.`);

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
