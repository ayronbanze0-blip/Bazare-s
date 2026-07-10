'use strict';

const router = require('express').Router();
const prisma = require('../config/database');

router.use('/auth', require('./authRoutes'));
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
router.use('/search', require('./searchRoutes'));
router.use('/reviews', require('./reviewRoutes'));
router.use('/wallet', require('./walletRoutes'));

// Verifica também a ligação à base de dados — se a DB estiver em baixo,
// o Railway deve marcar a instância como não saudável (503), em vez de
// continuar a encaminhar pedidos para um servidor que não consegue
// responder a nada de útil.
router.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ success: true, message: 'Bazares API está operacional.', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(503).json({ success: false, message: 'Base de dados indisponível.', db: 'down', timestamp: new Date().toISOString() });
  }
});

module.exports = router;

