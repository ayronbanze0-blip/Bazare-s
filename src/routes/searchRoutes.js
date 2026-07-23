'use strict';

const router = require('express').Router();
const { ok, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const aiSvc = require('../services/aiService');
const logger = require('../utils/logger');

// Singleton partilhado — ver nota em controllers/chatController.js
const prisma = require('../config/database');

// GET /search/suggestions?q=...
// Returns up to 5 products + 3 bazars matching the query
router.get('/suggestions', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return ok(res, { suggestions: [] });

    const term = q.trim();
    const [products, bazars] = await Promise.all([
      prisma.product.findMany({
        where: {
          active: true,
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } }
          ]
        },
        take: 5,
        select: {
          id: true,
          name: true,
          price: true,
          category: true,
          images: { orderBy: { order: 'asc' }, take: 1, select: { url: true } }
        }
      }),
      prisma.bazar.findMany({
        where: {
          active: true,
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } }
          ]
        },
        take: 3,
        select: { id: true, name: true, slug: true, logoUrl: true }
      })
    ]);

    const suggestions = [
      ...bazars.map(b => ({ type: 'bazar', id: b.id, slug: b.slug, label: b.name, imageUrl: b.logoUrl })),
      ...products.map(p => ({ type: 'product', id: p.id, label: p.name, sub: p.category, imageUrl: p.images[0]?.url || null }))
    ];

    return ok(res, { suggestions });
  } catch (err) {
    logger.error(`[Search.suggestions] ${err.message}`);
    return serverError(res);
  }
});

// GET /search/smart?q=... — pesquisa em linguagem natural
// Ex: "vestido azul para casamento até 1500 MT"
// A IA extrai keywords/categoria/preço, depois fazemos a query normal
// à base de dados — a IA nunca decide o que aparece, só interpreta.
router.get('/smart', async (req, res) => {
  try {
    const { q = '', page = 1, limit = 20 } = req.query;
    if (!q.trim()) return ok(res, { products: [], meta: { total: 0, page: 1, limit: 20, pages: 0 }, interpreted: null });

    const interpretation = await aiSvc.interpretSearchQuery(q.trim());

    // Falha aberta: se a IA falhar, cai para pesquisa simples por texto.
    const keywords = interpretation.ok ? (interpretation.keywords || q.trim()) : q.trim();
    const category = interpretation.ok ? interpretation.category : null;
    const minPrice = interpretation.ok ? interpretation.minPrice : null;
    const maxPrice = interpretation.ok ? interpretation.maxPrice : null;

    const { take, skip } = paginate(page, limit);
    const where = {
      active: true,
      OR: [
        { name: { contains: keywords, mode: 'insensitive' } },
        { description: { contains: keywords, mode: 'insensitive' } }
      ],
      ...(category && { category: { contains: category, mode: 'insensitive' } }),
      ...((minPrice != null || maxPrice != null) && {
        price: {
          ...(minPrice != null && { gte: minPrice }),
          ...(maxPrice != null && { lte: maxPrice })
        }
      })
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        take,
        skip,
        orderBy: [{ seller: { isPremium: 'desc' } }, { featured: 'desc' }, { sales: 'desc' }, { createdAt: 'desc' }],
        include: { images: { take: 1, orderBy: { order: 'asc' } }, bazar: { select: { id: true, name: true, slug: true } } }
      }),
      prisma.product.count({ where })
    ]);

    return ok(res, {
      products,
      meta: paginateMeta(total, page, limit),
      interpreted: interpretation.ok ? { keywords, category, minPrice, maxPrice } : null
    });
  } catch (err) {
    logger.error(`[Search.smart] ${err.message}`);
    return serverError(res);
  }
});

module.exports = router;

