'use strict';

/**
 * Contagem de visualizações (produtos, bazares, reels, posts, perfis).
 *  - total + visitantes únicos por dia (ViewDaily/ViewVisitor), sem guardar IPs
 *  - o dono nunca conta como visita; alvos inexistentes/inactivos são ignorados em silêncio
 *  - anti-spam: a mesma pessoa só incrementa o total 1x por alvo a cada 30 min (shouldCount)
 *  - histórico "vistos recentemente" do comprador (produtos)
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { createTtlCache } = require('../utils/ttlCache');
const { shouldCount } = require('../utils/dedupWindow');
const rules = require('./viewsRules');
const { AppError, forbiddenErr, notFoundErr } = require('../utils/appError');

const DEDUP_MS = 30 * 60 * 1000;
const HISTORY_MAX = 60;
// dono/estado do alvo muda raramente → cache curto evita 1 query por visita
const targetCache = createTtlCache({ ttlMs: 5 * 60 * 1000, max: 5000 });

/** { ownerId, active } do alvo, ou null se não existe. */
async function resolveTarget(type, id) {
  const key = `${type}:${id}`;
  const hit = targetCache.get(key);
  if (hit !== undefined) return hit;
  let value = null;
  switch (type) {
    case 'PRODUCT': {
      const p = await prisma.product.findUnique({ where: { id }, select: { sellerId: true, active: true, bazar: { select: { active: true } } } });
      if (p) value = { ownerId: p.sellerId, active: p.active && (p.bazar ? p.bazar.active : true) };
      break;
    }
    case 'BAZAR': {
      const b = await prisma.bazar.findUnique({ where: { id }, select: { sellerId: true, active: true } });
      if (b) value = { ownerId: b.sellerId, active: b.active };
      break;
    }
    case 'REEL': {
      const r = await prisma.reel.findUnique({ where: { id }, select: { sellerId: true } });
      if (r) value = { ownerId: r.sellerId, active: true };
      break;
    }
    case 'POST': {
      const a = await prisma.announcement.findUnique({ where: { id }, select: { sellerId: true } });
      if (a) value = { ownerId: a.sellerId, active: true };
      break;
    }
    case 'PROFILE': {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });
      if (u) value = { ownerId: u.id, active: u.active };
      break;
    }
    default: value = null;
  }
  // "não existe" também fica em cache (curto) para não martelar a BD com ids inventados
  targetCache.set(key, value, value ? undefined : 60 * 1000);
  return value;
}

/**
 * Regista uma visualização. Nunca lança por falha de BD (contar visitas não pode partir uma página).
 * @returns {Promise<{counted:boolean, reason?:string}>}
 */
async function track({ type, id, userId = null, ip = '', userAgent = '', now = new Date() }) {
  try {
    const target = await resolveTarget(type, id);
    if (!target) return { counted: false, reason: 'not_found' };
    if (!target.active) return { counted: false, reason: 'inactive' };
    if (userId && userId === target.ownerId) return { counted: false, reason: 'owner' };

    const viewer = rules.visitorKey({ userId, ip, userAgent, now });
    const day = rules.dayDate(now);

    // Histórico do comprador (não depende do anti-spam de 30 min — actualiza "visto por último")
    if (type === 'PRODUCT' && userId) recordHistory(userId, id, now).catch(() => {});

    if (!shouldCount('view', viewer, `${type}:${id}`, DEDUP_MS)) return { counted: false, reason: 'duplicate' };

    // único do dia? (createMany+skipDuplicates devolve quantas linhas entraram)
    const inserted = await prisma.viewVisitor.createMany({ data: [{ targetType: type, targetId: id, day, visitorKey: viewer }], skipDuplicates: true });
    const unique = inserted.count > 0 ? 1 : 0;

    await prisma.viewDaily.upsert({
      where: { targetType_targetId_day: { targetType: type, targetId: id, day } },
      create: { targetType: type, targetId: id, day, views: 1, uniques: unique },
      update: { views: { increment: 1 }, ...(unique && { uniques: { increment: 1 } }) }
    });

    // Contadores históricos já usados na app (ordenação/ecrãs existentes)
    if (type === 'PRODUCT') await prisma.product.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {});
    if (type === 'REEL') await prisma.reel.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {});
    return { counted: true };
  } catch (err) {
    logger.warn(`[Views.track] ${type}:${id} — ${err.message}`);
    return { counted: false, reason: 'error' };
  }
}

async function recordHistory(userId, productId, now = new Date()) {
  await prisma.viewHistory.upsert({
    where: { userId_productId: { userId, productId } },
    create: { userId, productId, lastViewedAt: now },
    update: { viewCount: { increment: 1 }, lastViewedAt: now }
  });
  // Mantém só os HISTORY_MAX mais recentes
  const extra = await prisma.viewHistory.findMany({ where: { userId }, orderBy: { lastViewedAt: 'desc' }, skip: HISTORY_MAX, select: { id: true } });
  if (extra.length) await prisma.viewHistory.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
}

// ─────────────────────────────────────────────────────────────────
// Estatísticas
// ─────────────────────────────────────────────────────────────────
async function assertCanSee(user, type, id) {
  const target = await resolveTarget(type, id);
  if (!target) throw notFoundErr('Não encontrado.');
  if (user.role !== 'ADMIN' && target.ownerId !== user.id) throw forbiddenErr('Só o dono pode ver estas estatísticas.');
  return target;
}

/** Estatísticas de UM alvo: totais, únicos, série diária (sem buracos) e variação face ao período anterior. */
async function targetStats(user, type, id, days) {
  await assertCanSee(user, type, id);
  const now = new Date();
  const start = rules.windowStart(days, now);
  const prevStart = new Date(start.getTime() - days * 86400000);
  const [rows, prevAgg] = await Promise.all([
    prisma.viewDaily.findMany({ where: { targetType: type, targetId: id, day: { gte: start } }, orderBy: { day: 'asc' } }),
    prisma.viewDaily.aggregate({ where: { targetType: type, targetId: id, day: { gte: prevStart, lt: start } }, _sum: { views: true, uniques: true } })
  ]);
  const views = rows.reduce((s, r) => s + r.views, 0);
  const uniques = rows.reduce((s, r) => s + r.uniques, 0);
  const prevViews = prevAgg._sum.views || 0;
  return {
    type, id, days, views, uniquesSum: uniques,
    previous: { views: prevViews, uniquesSum: prevAgg._sum.uniques || 0 },
    changePct: rules.changePct(views, prevViews),
    series: rules.fillSeries(rows, days, now)
  };
}

/**
 * Resumo do vendedor: visitas à loja, ao perfil, aos reels/posts, top produtos e funil
 * (visualizações → adicionou ao carrinho → encomendas) por produto.
 */
async function sellerSummary(sellerId, days) {
  const now = new Date();
  const start = rules.windowStart(days, now);
  const prevStart = new Date(start.getTime() - days * 86400000);

  const [bazar, products] = await Promise.all([
    prisma.bazar.findUnique({ where: { sellerId }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { sellerId }, select: { id: true, name: true, price: true, slug: true, views: true, images: { take: 1, orderBy: { order: 'asc' }, select: { url: true } } } })
  ]);
  const productIds = products.map((p) => p.id);
  const [reels, posts] = await Promise.all([
    prisma.reel.findMany({ where: { sellerId }, select: { id: true } }),
    prisma.announcement.findMany({ where: { sellerId }, select: { id: true } })
  ]);

  const [productRows, bazarRows, profileRows, reelAgg, postAgg, prevAgg, stats, orderAgg] = await Promise.all([
    prisma.viewDaily.groupBy({ by: ['targetId'], where: { targetType: 'PRODUCT', targetId: { in: productIds }, day: { gte: start } }, _sum: { views: true, uniques: true } }),
    bazar ? prisma.viewDaily.findMany({ where: { targetType: 'BAZAR', targetId: bazar.id, day: { gte: start } }, orderBy: { day: 'asc' } }) : [],
    prisma.viewDaily.aggregate({ where: { targetType: 'PROFILE', targetId: sellerId, day: { gte: start } }, _sum: { views: true, uniques: true } }),
    prisma.viewDaily.aggregate({ where: { targetType: 'REEL', targetId: { in: reels.map((r) => r.id) }, day: { gte: start } }, _sum: { views: true } }),
    prisma.viewDaily.aggregate({ where: { targetType: 'POST', targetId: { in: posts.map((r) => r.id) }, day: { gte: start } }, _sum: { views: true } }),
    bazar ? prisma.viewDaily.aggregate({ where: { targetType: 'BAZAR', targetId: bazar.id, day: { gte: prevStart, lt: start } }, _sum: { views: true } }) : { _sum: { views: 0 } },
    prisma.productStat.findMany({ where: { productId: { in: productIds } }, select: { productId: true, cartAdds: true } }).catch(() => []),
    prisma.orderItem.groupBy({ by: ['productId'], where: { productId: { in: productIds }, order: { createdAt: { gte: start }, status: { not: 'CANCELADA' } } }, _sum: { qty: true }, _count: { _all: true } })
  ]);

  const cartAddsBy = new Map(stats.map((s) => [s.productId, s.cartAdds]));
  const ordersBy = new Map(orderAgg.map((o) => [o.productId, o._count._all]));
  const viewsBy = new Map(productRows.map((r) => [r.targetId, r._sum]));

  const topProducts = products
    .map((p) => {
      const v = viewsBy.get(p.id) || { views: 0, uniques: 0 };
      const orders = ordersBy.get(p.id) || 0;
      return {
        id: p.id, name: p.name, price: p.price, slug: p.slug, imageUrl: p.images?.[0]?.url || null,
        views: v.views || 0, uniques: v.uniques || 0,
        cartAddsTotal: cartAddsBy.get(p.id) || 0, orders,
        conversionPct: v.uniques ? Math.round((orders / v.uniques) * 1000) / 10 : 0
      };
    })
    .sort((a, b) => b.views - a.views);

  const bazarViews = bazarRows.reduce((s, r) => s + r.views, 0);
  return {
    days,
    bazar: bazar ? {
      views: bazarViews, uniquesSum: bazarRows.reduce((s, r) => s + r.uniques, 0),
      previousViews: prevAgg._sum.views || 0, changePct: rules.changePct(bazarViews, prevAgg._sum.views || 0),
      series: rules.fillSeries(bazarRows, days, now)
    } : null,
    profile: { views: profileRows._sum.views || 0, uniquesSum: profileRows._sum.uniques || 0 },
    reels: { views: reelAgg._sum.views || 0 },
    posts: { views: postAgg._sum.views || 0 },
    products: { views: topProducts.reduce((s, p) => s + p.views, 0), top: topProducts.slice(0, 10) },
    note: 'uniquesSum soma os visitantes únicos de cada dia (a mesma pessoa em dias diferentes conta em cada um).'
  };
}

// ─────────────────────────────────────────────────────────────────
// Vistos recentemente (comprador)
// ─────────────────────────────────────────────────────────────────
async function recentlyViewed(userId, { limit = 20 } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), HISTORY_MAX);
  const rows = await prisma.viewHistory.findMany({
    where: { userId, product: { active: true, bazar: { active: true } } },
    orderBy: { lastViewedAt: 'desc' }, take,
    include: { product: { include: { images: { take: 1, orderBy: { order: 'asc' } }, bazar: { select: { id: true, name: true, slug: true } } } } }
  });
  return rows.map((r) => ({ lastViewedAt: r.lastViewedAt, viewCount: r.viewCount, product: r.product }));
}

const clearHistory = (userId) => prisma.viewHistory.deleteMany({ where: { userId } }).then((r) => r.count);
const removeFromHistory = (userId, productId) => prisma.viewHistory.deleteMany({ where: { userId, productId } }).then((r) => r.count);

/** Job: apaga marcas de visitante antigas (só serviam para contar únicos do dia) e séries muito antigas. */
async function maintenance(now = new Date()) {
  const visitorCutoff = new Date(rules.dayDate(now).getTime() - 40 * 86400000);
  const dailyCutoff = new Date(rules.dayDate(now).getTime() - 800 * 86400000);
  const [v, d] = await Promise.all([
    prisma.viewVisitor.deleteMany({ where: { day: { lt: visitorCutoff } } }),
    prisma.viewDaily.deleteMany({ where: { day: { lt: dailyCutoff } } })
  ]);
  if (v.count || d.count) logger.info(`[Views.maintenance] ${v.count} marcas e ${d.count} dias antigos removidos.`);
  return { visitors: v.count, daily: d.count };
}

module.exports = { track, resolveTarget, targetStats, sellerSummary, recentlyViewed, clearHistory, removeFromHistory, maintenance, AppError };
