'use strict';

const router = require('express').Router();

router.use('/auth', require('./authRoutes'));
router.use('/search', require('./searchRoutes'));
router.use('/products', require('./productRoutes'));
router.use('/bazars', require('./bazarRoutes'));
router.use('/orders', require('./orderRoutes'));
router.use('/finance', require('./financeRoutes'));
router.use('/chat', require('./chatRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/revendedor', require('./revendedorRoutes'));
router.use('/admin', require('./adminRoutes'));
router.use('/reports', require('./reportRoutes'));
router.use('/cart', require('./cartRoutes'));
router.use('/users', require('./userRoutes'));

router.get('/health', async (req, res) => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = require('../config/database');
  let dbOk = false;
  try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch {}
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    success: dbOk,
    message: dbOk ? 'Bazares API está operacional.' : 'Base de dados indisponível.',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: { database: dbOk ? 'ok' : 'error' }
  });
});

// Categorias disponíveis — útil para popular filtros e dropdowns no frontend
router.get('/categories', async (req, res) => {
  const prisma = require('../config/database');
  try {
    const [productCats, bazarCats] = await Promise.all([
      prisma.product.groupBy({ by: ['category'], _count: true, where: { active: true }, orderBy: { _count: { category: 'desc' } } }),
      prisma.bazar.groupBy({ by: ['category'], _count: true, where: { active: true }, orderBy: { _count: { category: 'desc' } } })
    ]);
    res.json({
      success: true,
      data: {
        products: productCats.map(c => ({ name: c.category, count: c._count })),
        bazars: bazarCats.map(c => ({ name: c.category, count: c._count }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro ao carregar categorias.' });
  }
});

module.exports = router;
