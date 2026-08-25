'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { optionalAuth, authenticate, isAdmin } = require('../middleware/auth');
const { tooMany } = require('../utils/response');
const ctrl = require('../controllers/analyticsController');

// Limiter próprio: o frontend envia em lote (até 20 eventos por
// pedido, a cada ~12s, ou ao esconder/fechar a página), mas várias
// pessoas por trás do mesmo IP (wifi partilhado, dados móveis com
// CGNAT — comum em MZ) não podem ficar bloqueadas pelo apiLimiter
// geral. Mais generoso, sem deixar de ter tecto.
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => tooMany(res, 'Demasiados eventos de analytics. Aguarde um momento.')
});

// POST /api/analytics/events
// Público (optionalAuth) — recebe de visitantes anónimos e autenticados.
router.post('/events', analyticsLimiter, optionalAuth, ctrl.trackEvents);

// GET /api/analytics/summary — só admin.
router.get('/summary', authenticate, isAdmin, ctrl.summary);

// GET /api/analytics/routes-health — só admin. Ver comentário no controller.
router.get('/routes-health', authenticate, isAdmin, ctrl.routesHealth);

module.exports = router;
