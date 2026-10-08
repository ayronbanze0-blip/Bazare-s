'use strict';

/**
 * Cupões de desconto e promoções de produto.
 * - Seller: CRUD de cupões e de promoções (sempre sobre os SEUS produtos).
 * - Comprador: validação/aplicação no checkout (ver checkoutService) — o desconto é calculado pelo servidor.
 * - redeemTx/revertForOrderTx: ligação à encomenda, dentro da mesma transacção (uso limitado e reversível).
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const notifSvc = require('./notificationService');
const R = require('./pricingRules');
const { AppError, bad, notFoundErr, forbiddenErr, conflictErr } = require('../utils/appError');
const { round2 } = require('../utils/validate');

const MAX_COUPONS_PER_SELLER = 100;
const MAX_ACTIVE_PROMOS_PER_SELLER = 200;
const fmt = (n) => Number(n).toLocaleString('pt-MZ');

// ═════════════════════════════════════════════════════════════════
// Cupões — vendedor
// ═════════════════════════════════════════════════════════════════
const publicCoupon = (c) => ({
  id: c.id, code: c.code, description: c.description, type: c.type, value: c.value,
  minOrderAmount: c.minOrderAmount, maxDiscount: c.maxDiscount, usageLimit: c.usageLimit, usedCount: c.usedCount,
  perUserLimit: c.perUserLimit, firstOrderOnly: c.firstOrderOnly, productIds: c.productIds,
  startsAt: c.startsAt, expiresAt: c.expiresAt, active: c.active, createdAt: c.createdAt,
  status: couponStatus(c)
});

/** Estado legível: ACTIVE | SCHEDULED | EXPIRED | EXHAUSTED | DISABLED */
const couponStatus = (c, now = new Date()) => {
  if (!c.active) return 'DISABLED';
  if (c.expiresAt && new Date(c.expiresAt) <= now) return 'EXPIRED';
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return 'EXHAUSTED';
  if (c.startsAt && new Date(c.startsAt) > now) return 'SCHEDULED';
  return 'ACTIVE';
};

async function assertOwnsProducts(sellerId, productIds) {
  if (!productIds || productIds.length === 0) return;
  const n = await prisma.product.count({ where: { id: { in: productIds }, sellerId } });
  if (n !== productIds.length) throw forbiddenErr('Só podes aplicar o cupão a produtos teus.', 'COUPON_FOREIGN_PRODUCTS');
}

const createCoupon = async (sellerId, body) => {
  const data = R.parseCouponInput(body);
  if (data.type === 'FIXED' && data.maxDiscount != null) throw bad('"maxDiscount" só se aplica a cupões em percentagem.', 'COUPON_BAD_VALUE');
  await assertOwnsProducts(sellerId, data.productIds);
  const count = await prisma.coupon.count({ where: { sellerId } });
  if (count >= MAX_COUPONS_PER_SELLER) throw bad(`Limite de ${MAX_COUPONS_PER_SELLER} cupões atingido. Apaga os que já não usas.`, 'COUPON_LIMIT');
  try {
    const c = await prisma.coupon.create({ data: { ...data, sellerId, productIds: data.productIds || [] } });
    return publicCoupon(c);
  } catch (err) {
    if (err.code === 'P2002') throw conflictErr('Este código já existe. Escolhe outro.', 'COUPON_CODE_TAKEN');
    throw err;
  }
};

const listCoupons = async (sellerId, { status, page = 1, limit = 30 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const [rows, total] = await Promise.all([
    prisma.coupon.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.coupon.count({ where: { sellerId } })
  ]);
  let items = rows.map(publicCoupon);
  if (status) items = items.filter((c) => c.status === String(status).toUpperCase());
  return { coupons: items, meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) } };
};

const ownCoupon = async (sellerId, id, role) => {
  const c = await prisma.coupon.findUnique({ where: { id } });
  if (!c) throw notFoundErr('Cupão não encontrado.');
  if (c.sellerId !== sellerId && role !== 'ADMIN') throw forbiddenErr();
  return c;
};

const updateCoupon = async (user, id, body) => {
  const current = await ownCoupon(user.id, id, user.role);
  if ('code' in body && body.code !== undefined) throw bad('O código não pode ser alterado — cria um cupão novo.', 'COUPON_CODE_IMMUTABLE');
  const data = R.parseCouponInput({ type: current.type, ...body }, { partial: true });
  if ('type' in body) throw bad('O tipo não pode ser alterado depois de criado.', 'COUPON_TYPE_IMMUTABLE');
  delete data.type;
  if (data.value !== undefined && current.type === 'PERCENT' && data.value > R.MAX_PERCENT) throw bad(`Desconto em % no máximo ${R.MAX_PERCENT}.`, 'COUPON_BAD_VALUE');
  if (data.usageLimit != null && data.usageLimit < current.usedCount) throw bad(`O limite não pode ser inferior às ${current.usedCount} utilizações já feitas.`, 'COUPON_BAD_LIMIT');
  if (data.productIds) await assertOwnsProducts(current.sellerId, data.productIds);
  const start = data.startsAt !== undefined ? data.startsAt : current.startsAt;
  const end = data.expiresAt !== undefined ? data.expiresAt : current.expiresAt;
  if (start && end && new Date(end) <= new Date(start)) throw bad('A validade tem de ser depois do início.', 'COUPON_BAD_DATES');
  const c = await prisma.coupon.update({ where: { id }, data });
  return publicCoupon(c);
};

const deleteCoupon = async (user, id) => {
  const c = await ownCoupon(user.id, id, user.role);
  const used = await prisma.couponRedemption.count({ where: { couponId: id } });
  if (used > 0) {
    // Já foi usado: não se apaga (histórico das encomendas) — só desactiva.
    await prisma.coupon.update({ where: { id }, data: { active: false } });
    return { deleted: false, deactivated: true };
  }
  await prisma.coupon.delete({ where: { id: c.id } });
  return { deleted: true, deactivated: false };
};

const couponRedemptions = async (user, id, { page = 1, limit = 30 } = {}) => {
  await ownCoupon(user.id, id, user.role);
  const take = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { couponId: id };
  const [rows, total, agg] = await Promise.all([
    prisma.couponRedemption.findMany({
      where, orderBy: { createdAt: 'desc' }, take, skip,
      include: { user: { select: { id: true, name: true, avatarUrl: true } }, order: { select: { id: true, total: true, status: true } } }
    }),
    prisma.couponRedemption.count({ where }),
    prisma.couponRedemption.aggregate({ where: { couponId: id, status: 'APPLIED' }, _sum: { amount: true }, _count: { _all: true } })
  ]);
  return {
    redemptions: rows,
    summary: { applied: agg._count._all, totalDiscount: round2(agg._sum.amount || 0) },
    meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) }
  };
};

// ═════════════════════════════════════════════════════════════════
// Cupões — aplicação na encomenda (dentro da transacção)
// ═════════════════════════════════════════════════════════════════
/**
 * Regista a utilização. Re-verifica TUDO dentro da transacção, sob lock do par (cupão, comprador):
 * é esta a garantia contra dois pedidos simultâneos a gastarem o último uso / o limite por pessoa.
 */
async function redeemTx(tx, { coupon, userId, orderId, amount, now = new Date() }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coupon:${coupon.id}:${userId}`}))`;
  const used = await tx.couponRedemption.count({ where: { couponId: coupon.id, userId, status: 'APPLIED' } });
  if (used >= (coupon.perUserLimit || 1)) throw new AppError('Já utilizaste este cupão o número máximo de vezes.', 400, 'COUPON_ALREADY_USED');

  const claim = await tx.coupon.updateMany({
    where: {
      id: coupon.id, active: true,
      ...(coupon.usageLimit != null && { usedCount: { lt: coupon.usageLimit } }),
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: [{ startsAt: null }, { startsAt: { lte: now } }] }]
    },
    data: { usedCount: { increment: 1 } }
  });
  if (claim.count === 0) throw new AppError('Este cupão já não está disponível.', 400, 'COUPON_EXHAUSTED');
  await tx.couponRedemption.create({ data: { couponId: coupon.id, userId, orderId, amount: round2(amount) } });
}

/** Cancelamento da encomenda: devolve a utilização (liberta o limite do cupão e do comprador). */
async function revertForOrderTx(tx, orderId) {
  const reds = await tx.couponRedemption.findMany({ where: { orderId, status: 'APPLIED' } });
  for (const r of reds) {
    const claim = await tx.couponRedemption.updateMany({ where: { id: r.id, status: 'APPLIED' }, data: { status: 'REVERTED', revertedAt: new Date() } });
    if (claim.count === 1) await tx.coupon.update({ where: { id: r.couponId }, data: { usedCount: { decrement: 1 } } });
  }
  return reds.length;
}

// ═════════════════════════════════════════════════════════════════
// Promoções de produto
// ═════════════════════════════════════════════════════════════════
/** Devolve Map<productId, promo> só com as promoções EM VIGOR agora. */
async function livePromotions(productIds, now = new Date(), client = prisma) {
  if (!productIds.length) return new Map();
  const rows = await client.productPromotion.findMany({
    where: { productId: { in: productIds }, active: true, startsAt: { lte: now }, endsAt: { gt: now } }
  });
  return new Map(rows.filter((p) => R.promoIsLive(p, now)).map((p) => [p.productId, p]));
}

/**
 * Aplica (ou não) a promoção a UM produto para ser mostrado a `viewerId`.
 *  - em promoção: `price` passa a ser o preço NOVO e `originalPrice` o antigo (a app risca-o) —
 *    assim qualquer ecrã que mostre `price` já mostra o preço certo sem mudanças.
 *  - o DONO do produto vê sempre o preço real em `price` (senão, ao editar, gravava o preço promocional
 *    como se fosse o de tabela); recebe os mesmos campos extra para pré-visualizar a promoção.
 * Campos acrescentados: listPrice, originalPrice, effectivePrice, onSale, discountPercent, promotion.
 */
function applyPromo(product, promo, now = new Date(), viewerId = null) {
  const e = R.effectivePrice(product, promo, now);
  const isOwner = Boolean(viewerId) && product.sellerId === viewerId;
  return {
    ...product,
    price: e.onSale && !isOwner ? e.unitPrice : product.price,
    listPrice: e.listPrice,
    originalPrice: e.onSale ? e.listPrice : null, // preço riscado (null = sem promoção)
    effectivePrice: e.unitPrice, onSale: e.onSale, discountPercent: e.discountPercent,
    promotion: e.onSale && promo ? { salePrice: promo.salePrice, label: promo.label, endsAt: promo.endsAt } : null
  };
}

/**
 * Decora produtos com a promoção em vigor (ver applyPromo). Falha em silêncio — se a tabela ainda não
 * existir devolve os produtos como estão: listar produtos nunca pode depender desta funcionalidade.
 */
async function attachPromotions(products, { viewerId = null } = {}) {
  if (!Array.isArray(products) || products.length === 0) return products;
  try {
    const now = new Date();
    const promos = await livePromotions(products.map((p) => p.id), now);
    return products.map((p) => applyPromo(p, promos.get(p.id), now, viewerId));
  } catch (err) {
    logger.warn(`[attachPromotions] ${err.message}`);
    return products;
  }
}

const publicPromo = (p, now = new Date()) => ({
  productId: p.productId, salePrice: p.salePrice, originalPrice: p.originalPrice, label: p.label,
  startsAt: p.startsAt, endsAt: p.endsAt, active: p.active,
  status: !p.active ? 'DISABLED' : new Date(p.endsAt) <= now ? 'ENDED' : new Date(p.startsAt) > now ? 'SCHEDULED' : 'LIVE',
  discountPercent: Math.round(((p.originalPrice - p.salePrice) / p.originalPrice) * 100),
  ...(p.product && { product: p.product })
});

const upsertPromotion = async (sellerId, productId, body) => {
  const product = await prisma.product.findFirst({ where: { id: productId, sellerId } });
  if (!product) throw notFoundErr('Produto não encontrado.');
  const data = R.parsePromotionInput(body, product.price);

  const existing = await prisma.productPromotion.findUnique({ where: { productId } });
  if (!existing) {
    const active = await prisma.productPromotion.count({ where: { sellerId, active: true, endsAt: { gt: new Date() } } });
    if (active >= MAX_ACTIVE_PROMOS_PER_SELLER) throw bad(`Limite de ${MAX_ACTIVE_PROMOS_PER_SELLER} promoções activas atingido.`, 'PROMO_LIMIT');
  }
  const promo = await prisma.productPromotion.upsert({
    where: { productId },
    create: { productId, sellerId, originalPrice: product.price, active: true, ...data },
    update: { originalPrice: product.price, active: true, ...data }
  });

  // Avisa quem tem o produto nos favoritos (só quando a promoção já está/entra em vigor e é nova ou mais barata)
  const isNewOrCheaper = !existing || data.salePrice < existing.salePrice || !existing.active;
  if (isNewOrCheaper && data.startsAt <= new Date()) notifyFavoriters(product, promo).catch(() => {});
  return publicPromo(promo);
};

async function notifyFavoriters(product, promo) {
  const favs = await prisma.favorite.findMany({ where: { productId: product.id, userId: { not: product.sellerId } }, select: { userId: true }, take: 500 });
  if (!favs.length) return 0;
  await notifSvc.warmPrefs(favs.map((f) => f.userId));
  const pct = Math.round(((promo.originalPrice - promo.salePrice) / promo.originalPrice) * 100);
  await Promise.all(favs.map((f) => notifSvc.push(f.userId, {
    type: 'INFO', category: 'marketing', title: `-${pct}% num produto que guardaste`,
    message: `"${product.name}" está por ${fmt(promo.salePrice)} MT (antes ${fmt(promo.originalPrice)} MT).`,
    link: `product.html?id=${product.id}`
  })));
  return favs.length;
}

const endPromotion = async (sellerId, productId) => {
  const claim = await prisma.productPromotion.updateMany({ where: { productId, sellerId }, data: { active: false } });
  if (claim.count === 0) throw notFoundErr('Promoção não encontrada.');
  return { ended: true };
};

const listPromotions = async (sellerId, { status } = {}) => {
  const rows = await prisma.productPromotion.findMany({
    where: { sellerId }, orderBy: { endsAt: 'desc' }, take: 200,
    include: { product: { select: { id: true, name: true, price: true, slug: true, images: { take: 1, orderBy: { order: 'asc' }, select: { url: true } } } } }
  });
  const items = rows.map((p) => publicPromo(p));
  return { promotions: status ? items.filter((p) => p.status === String(status).toUpperCase()) : items };
};

/** Feed público de ofertas (promoções em vigor), mais recentes primeiro ou maior desconto. */
const publicDeals = async ({ page = 1, limit = 20, sort = 'discount', category } = {}, viewerId = null) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const now = new Date();
  const where = {
    active: true, startsAt: { lte: now }, endsAt: { gt: now },
    product: { active: true, stock: { gt: 0 }, bazar: { active: true }, ...(category && { category: String(category) }) }
  };
  const rows = await prisma.productPromotion.findMany({
    where, take: 300,
    orderBy: sort === 'ending' ? { endsAt: 'asc' } : { updatedAt: 'desc' },
    include: { product: { include: { images: { take: 1, orderBy: { order: 'asc' } }, bazar: { select: { id: true, name: true, slug: true } } } } }
  });
  let deals = rows
    .filter((p) => R.promoIsLive(p, now) && p.salePrice < p.product.price)
    .map((p) => applyPromo(p.product, p, now, viewerId));
  if (sort === 'discount') deals.sort((a, b) => b.discountPercent - a.discountPercent);
  const total = deals.length;
  deals = deals.slice(skip, skip + take);
  return { deals, meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) } };
};

/** Job: desactiva promoções terminadas (a leitura já as ignora; isto mantém a BD limpa). */
async function expirePromotions() {
  const r = await prisma.productPromotion.updateMany({ where: { active: true, endsAt: { lte: new Date() } }, data: { active: false } });
  if (r.count) logger.info(`[Promotions] ${r.count} promoção(ões) terminada(s).`);
  return r.count;
}

module.exports = {
  couponStatus, publicCoupon,
  createCoupon, listCoupons, updateCoupon, deleteCoupon, couponRedemptions,
  redeemTx, revertForOrderTx,
  livePromotions, applyPromo, attachPromotions, upsertPromotion, endPromotion, listPromotions, publicDeals, expirePromotions
};
