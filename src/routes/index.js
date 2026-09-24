'use strict';

const router = require('express').Router();
const { requireFeature } = require('../middleware/featureGate');
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
router.use('/seller', require('./sellerRoutes'));
router.use('/reports', require('./reportRoutes'));
router.use('/cart', require('./cartRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/search', require('./searchRoutes'));
router.use('/reviews', require('./reviewRoutes'));
router.use('/wallet', require('./walletRoutes'));
router.use('/premium', requireFeature('ENABLE_PREMIUM', { except: /^\/admin(\/|$)/ }), require('./premiumRoutes'));
router.use('/feed', requireFeature('ENABLE_SOCIAL_FEED'), require('./feedRoutes'));
router.use('/reels', requireFeature('ENABLE_REELS'), require('./reelRoutes'));
router.use('/stories', require('./storyRoutes'));
router.use('/ai', requireFeature('ENABLE_AI'), require('./aiRoutes'));
router.use('/media', require('./mediaRoutes'));
router.use('/analytics', require('./analyticsRoutes'));
router.use('/gamification', require('./gamificationRoutes'));
router.use('/polls', require('./pollRoutes'));
router.use('/groups', requireFeature('ENABLE_COMMUNITIES'), require('./communityRoutes'));
router.use('/admin/feature-flags', require('./featureFlagRoutes'));

// ─── Health checks ─────────────────────────────────────────────────
//  /api/health        → aplicação + BD (formato antigo mantido: o workflow de
//                       teste de carga procura `"db":"ok"`)
//  /api/health/live   → o processo está vivo (não toca na BD — para liveness probes)
//  /api/health/ready  → pronto para receber tráfego: BD acessível e a app não está
//                       a encerrar (para readiness probes / load balancer)
// Nenhum devolve versões, variáveis de ambiente, hosts ou mensagens de erro internas.
const dbCheck = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};

router.get('/health', async (req, res) => {
  if (await dbCheck()) {
    return res.json({ success: true, message: 'Bazares API está operacional.', db: 'ok', timestamp: new Date().toISOString() });
  }
  return res.status(503).json({ success: false, message: 'Base de dados indisponível.', db: 'down', timestamp: new Date().toISOString() });
});

router.get('/health/live', (req, res) =>
  res.json({ success: true, status: 'alive', uptimeSec: Math.round(process.uptime()), timestamp: new Date().toISOString() })
);

router.get('/health/ready', async (req, res) => {
  const isShuttingDown = req.app.get('isShuttingDown');
  if (typeof isShuttingDown === 'function' && isShuttingDown()) {
    return res.status(503).json({ success: false, status: 'shutting_down', timestamp: new Date().toISOString() });
  }
  const db = (await dbCheck()) ? 'ok' : 'down';
  const ready = db === 'ok';
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready',
    checks: { db },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;

