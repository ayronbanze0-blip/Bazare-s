'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/searchController');
const { apiLimiter } = require('../middleware/rateLimiter');

// rate limit aplicado só aqui (mais restritivo para pesquisa)
const searchLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,      // 1 minuto
  max: 60,                   // 60 pesquisas/min (autocomplete é intensivo)
  standardHeaders: true,
  legacyHeaders: false
});

router.get('/', searchLimiter, ctrl.search);
router.get('/suggestions', searchLimiter, ctrl.suggestions);

module.exports = router;
