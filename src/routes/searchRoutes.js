'use strict';

const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { ok, serverError } = require('../utils/response');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

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

module.exports = router;
