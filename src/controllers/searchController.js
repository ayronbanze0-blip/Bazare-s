'use strict';

const { ok, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── GET /api/search?q=...&type=all|products|bazars&page=1 ────────
// Pesquisa global unificada. O frontend pode usar ?type=products para
// resultados só de produtos (ex: barra de pesquisa inline) ou type=all
// para a página de resultados completa.
const search = async (req, res) => {
  try {
    const { q = '', type = 'all', category, page = 1, limit = 20 } = req.query;

    if (!q.trim()) return ok(res, { products: [], bazars: [], meta: { total: 0, page: 1, limit: 20, pages: 0 } });

    const { take, skip } = paginate(page, limit);
    const term = q.trim();

    const productWhere = {
      active: true,
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { category: { contains: term, mode: 'insensitive' } }
      ],
      ...(category && { category })
    };

    const bazarWhere = {
      active: true,
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { category: { contains: term, mode: 'insensitive' } }
      ]
    };

    let products = [];
    let bazars = [];
    let totalProducts = 0;
    let totalBazars = 0;

    if (type === 'all' || type === 'products') {
      [products, totalProducts] = await Promise.all([
        prisma.product.findMany({
          where: productWhere,
          take,
          skip,
          // Vendedores Premium aparecem primeiro, depois destaques do
          // admin (featured), depois por vendas/recência — a mesma
          // lógica usada em productController.list.
          orderBy: [{ seller: { isPremium: 'desc' } }, { featured: 'desc' }, { sales: 'desc' }, { createdAt: 'desc' }],
          include: {
            images: { take: 1, orderBy: { order: 'asc' } },
            bazar: { select: { id: true, name: true, slug: true } }
          }
        }),
        prisma.product.count({ where: productWhere })
      ]);
    }

    if (type === 'all' || type === 'bazars') {
      [bazars, totalBazars] = await Promise.all([
        prisma.bazar.findMany({
          where: bazarWhere,
          take: type === 'all' ? 5 : take, // em mode "all" mostra só 5 bazars
          skip: type === 'all' ? 0 : skip,
          orderBy: { totalSales: 'desc' },
          include: {
            seller: { select: { id: true, name: true, verifiedSeller: true, rating: true } },
            _count: { select: { products: { where: { active: true } } } }
          }
        }),
        prisma.bazar.count({ where: bazarWhere })
      ]);
    }

    const total = type === 'products' ? totalProducts
      : type === 'bazars' ? totalBazars
      : totalProducts + totalBazars;

    return ok(res, {
      products,
      bazars,
      meta: paginateMeta(total, page, limit),
      query: term
    });
  } catch (err) {
    logger.error(`[Search] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/search/suggestions?q=... ───────────────────────────
// Autocomplete leve: retorna só nomes (sem imagens/relações pesadas).
// Ideal para dropdown de pesquisa em tempo real.
const suggestions = async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (q.trim().length < 2) return ok(res, { suggestions: [] });

    const term = q.trim();

    const [products, bazars] = await Promise.all([
      prisma.product.findMany({
        where: { active: true, name: { contains: term, mode: 'insensitive' } },
        take: 5,
        select: { id: true, name: true, category: true },
        orderBy: { sales: 'desc' }
      }),
      prisma.bazar.findMany({
        where: { active: true, name: { contains: term, mode: 'insensitive' } },
        take: 3,
        select: { id: true, name: true, slug: true },
        orderBy: { totalSales: 'desc' }
      })
    ]);

    const suggestions = [
      ...products.map(p => ({ type: 'product', id: p.id, label: p.name, sub: p.category })),
      ...bazars.map(b => ({ type: 'bazar', id: b.id, label: b.name, slug: b.slug }))
    ];

    return ok(res, { suggestions });
  } catch (err) {
    logger.error(`[Search.suggestions] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { search, suggestions };
