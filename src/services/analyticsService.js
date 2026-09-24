'use strict';

/**
 * Analytics internos (vendedor e admin) — agregações baratas sobre as tabelas existentes.
 *
 * Regras:
 *  - Só COUNT/SUM/GROUP BY indexados; nada de carregar milhares de linhas para somar em JS.
 *  - Nenhum dado pessoal de compradores é devolvido (só totais).
 *  - `views` e `cartAdds` são contadores acumulados (vida inteira); o resto respeita o período.
 *  - Resultados de dashboards são guardados 60 s em cache (ttlCache) — ver docs.
 */

const { createTtlCache } = require('../utils/ttlCache');

const cache = createTtlCache({ ttlMs: 60 * 1000, max: 1000 });
const LOW_STOCK_THRESHOLD = () => Math.max(1, parseInt(process.env.LOW_STOCK_THRESHOLD, 10) || 3);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const PERIODS = new Set(['today', '7d', '30d', '90d', 'all']);

/** 'today' | '7d' | '30d' | '90d' | 'all' → { period, since|null }. Valor inválido → 30d. */
function periodRange(input, now = new Date()) {
  const period = PERIODS.has(input) ? input : '30d';
  if (period === 'all') return { period, since: null };
  if (period === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return { period, since: d };
  }
  const days = { '7d': 7, '30d': 30, '90d': 90 }[period];
  return { period, since: new Date(now.getTime() - days * 24 * 3600 * 1000) };
}

const sinceFilter = (since, field = 'createdAt') => (since ? { [field]: { gte: since } } : {});

/**
 * Métricas de UM produto. Devolve apenas totais (sem dados de compradores).
 */
async function productMetrics(prisma, product, since) {
  const id = product.id;
  const deliveredWhere = { productId: id, order: { status: 'ENTREGUE', ...sinceFilter(since) } };

  const [favorites, shares, orders, ordersTotal, soldGroups, stat] = await Promise.all([
    prisma.favorite.count({ where: { productId: id, ...sinceFilter(since) } }),
    prisma.feedShare.count({ where: { targetType: 'PRODUCT', targetId: id, ...sinceFilter(since) } }),
    prisma.order.count({ where: { items: { some: { productId: id } }, status: { not: 'CANCELADA' }, ...sinceFilter(since) } }),
    prisma.order.count({ where: { items: { some: { productId: id } }, status: { not: 'CANCELADA' } } }),
    prisma.orderItem.groupBy({ by: ['price'], where: deliveredWhere, _sum: { qty: true } }),
    // tabela nova: se ainda não existir (migração por aplicar) conta como 0 — nunca falha o dashboard
    prisma.productStat.findUnique({ where: { productId: id } }).catch(() => null)
  ]);

  let units = 0; let revenue = 0;
  for (const g of soldGroups) {
    const q = (g._sum && g._sum.qty) || 0;
    units += q; revenue += q * g.price;
  }
  const views = product.views || 0;
  return {
    productId: id,
    views,                                  // acumulado
    cartAdds: (stat && stat.cartAdds) || 0, // acumulado
    favorites, shares, orders,
    sales: { units, revenue: round2(revenue) },
    // encomendas (vida inteira) / visualizações (vida inteira), em %
    conversionRate: views > 0 ? round2((ordersTotal / views) * 100) : 0
  };
}

/** Dashboard do vendedor (cache 60 s por vendedor+período). */
function sellerDashboard(prisma, sellerId, { period, since }) {
  return cache.wrap(`seller:${sellerId}:${period}`, async () => {
    const threshold = LOW_STOCK_THRESHOLD();
    const deliveredOrders = { sellerId, status: 'ENTREGUE', ...sinceFilter(since) };

    const [products, active, lowStockCount, outOfStock, ordersByStatus, delivered, totals, favorites, lowStock, top] = await Promise.all([
      prisma.product.count({ where: { sellerId } }),
      prisma.product.count({ where: { sellerId, active: true } }),
      prisma.product.count({ where: { sellerId, active: true, stock: { gt: 0, lte: threshold } } }),
      prisma.product.count({ where: { sellerId, active: true, stock: { lte: 0 } } }),
      prisma.order.groupBy({ by: ['status'], where: { sellerId, ...sinceFilter(since) }, _count: { _all: true } }),
      prisma.order.aggregate({ where: deliveredOrders, _count: { _all: true }, _sum: { total: true, feeAmount: true } }),
      prisma.product.aggregate({ where: { sellerId }, _sum: { views: true } }),
      prisma.favorite.count({ where: { product: { sellerId }, ...sinceFilter(since) } }),
      prisma.product.findMany({
        where: { sellerId, active: true, stock: { lte: threshold } },
        orderBy: { stock: 'asc' }, take: 10, select: { id: true, name: true, stock: true }
      }),
      prisma.orderItem.groupBy({
        by: ['productId'], where: { order: deliveredOrders },
        _sum: { qty: true }, orderBy: { _sum: { qty: 'desc' } }, take: 5
      })
    ]);

    const cartStats = await prisma.productStat.aggregate({ where: { product: { sellerId } }, _sum: { cartAdds: true } }).catch(() => null);

    const names = top.length
      ? await prisma.product.findMany({ where: { id: { in: top.map((t) => t.productId) } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(names.map((n) => [n.id, n.name]));

    const orderCounts = {};
    for (const g of ordersByStatus) orderCounts[g.status] = g._count._all;
    const gross = (delivered._sum && delivered._sum.total) || 0;
    const fees = (delivered._sum && delivered._sum.feeAmount) || 0;

    return {
      period,
      sales: delivered._count._all,
      orders: { total: Object.values(orderCounts).reduce((a, b) => a + b, 0), byStatus: orderCounts },
      revenue: { gross: round2(gross), fees: round2(fees), net: round2(gross - fees) },
      products: { total: products, active, outOfStock, lowStock: lowStockCount, lowStockThreshold: threshold },
      views: (totals._sum && totals._sum.views) || 0,
      cartAdds: (cartStats && cartStats._sum && cartStats._sum.cartAdds) || 0,
      favorites,
      lowStock,
      topProducts: top.map((t) => ({ productId: t.productId, name: nameById.get(t.productId) || null, units: (t._sum && t._sum.qty) || 0 }))
    };
  });
}

/** Estatísticas da plataforma para o admin (cache 60 s por período). */
function adminAnalytics(prisma, { period, since }) {
  return cache.wrap(`admin:${period}`, async () => {
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const [users, sellers, activeUsers, newUsersToday, newUsers, products, activeProducts, orders, delivered, reports, pendingReports, premiumUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'SELLER' } }),
      prisma.user.count({ where: { active: true, ...(since ? { lastLoginAt: { gte: since } } : {}) } }),
      prisma.user.count({ where: { createdAt: { gte: startToday } } }),
      prisma.user.count({ where: sinceFilter(since) }),
      prisma.product.count(),
      prisma.product.count({ where: { active: true } }),
      prisma.order.count({ where: sinceFilter(since) }),
      prisma.order.aggregate({ where: { status: 'ENTREGUE', ...sinceFilter(since) }, _count: { _all: true }, _sum: { total: true, feeAmount: true } }),
      prisma.report.count({ where: sinceFilter(since) }),
      prisma.report.count({ where: { status: 'PENDENTE' } }),
      prisma.user.count({ where: { isPremium: true } })
    ]);
    return {
      period,
      users: { total: users, active: activeUsers, sellers, newInPeriod: newUsers, newToday: newUsersToday, premium: premiumUsers },
      products: { total: products, active: activeProducts },
      orders: { inPeriod: orders },
      sales: { count: delivered._count._all },
      revenue: { gross: round2((delivered._sum && delivered._sum.total) || 0), platformFees: round2((delivered._sum && delivered._sum.feeAmount) || 0) },
      reports: { inPeriod: reports, pending: pendingReports }
    };
  });
}

module.exports = { periodRange, productMetrics, sellerDashboard, adminAnalytics, cache, PERIODS };
