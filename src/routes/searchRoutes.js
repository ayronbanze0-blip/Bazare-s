'use strict';

const router = require('express').Router();
const { ok, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const aiSvc = require('../services/aiService');
const logger = require('../utils/logger');
const ctrl = require('../controllers/searchController');

// Singleton partilhado — ver nota em controllers/chatController.js
const prisma = require('../config/database');

// GET /search?q=...&type=all|products|bazars&page=1
// Pesquisa global unificada (implementada em searchController.search).
// Estava construída mas nunca tinha sido ligada a uma rota — o
// frontend não tinha forma de chegar à pesquisa completa, só ao
// autocomplete (/suggestions).
router.get('/', ctrl.search);

// GET /search/suggestions?q=...
// Returns up to 5 products + 3 bazars matching the query.
// Usa o controller em vez de reimplementar a mesma lógica aqui.
router.get('/suggestions', ctrl.suggestions);

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

