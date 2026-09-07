'use strict';

const router = require('express').Router();
const { ok, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const { aiLimiter } = require('../middleware/rateLimiter');
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
router.get('/smart', aiLimiter, async (req, res) => {
  try {
    const { q = '', page = 1, limit = 20 } = req.query;
    if (!q.trim()) return ok(res, { products: [], meta: { total: 0, page: 1, limit: 20, pages: 0 }, interpreted: null });

    const interpretation = await aiSvc.interpretSearchQuery(q.trim());

    // Falha aberta: se a IA falhar, cai para pesquisa simples por texto.
    // Validação rígida da resposta da IA — o Gemini pode devolver tipos
    // inesperados (minPrice="abc", category=[...], etc.) e isso rebentava
    // a query do Prisma com um erro 500. Nunca confiar cegamente no JSON
    // devolvido por um LLM para construir uma query de BD.
    const asFiniteNumber = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const asShortString = (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 100 ? v.trim() : null);

    const keywords = (interpretation.ok && asShortString(interpretation.keywords)) || q.trim().slice(0, 100);
    const category = interpretation.ok ? asShortString(interpretation.category) : null;
    let minPrice = interpretation.ok ? asFiniteNumber(interpretation.minPrice) : null;
    let maxPrice = interpretation.ok ? asFiniteNumber(interpretation.maxPrice) : null;
    // Se a IA trocar os limites (minPrice > maxPrice), ignoramos ambos em
    // vez de devolver uma query sem resultados possíveis.
    if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
      minPrice = null; maxPrice = null;
    }

    const { take, skip } = paginate(page, limit);
    const where = {
      active: true,
      // Consistente com o resto das listagens públicas.
      bazar: { active: true },
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

