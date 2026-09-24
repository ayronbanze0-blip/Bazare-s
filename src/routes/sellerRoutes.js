'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/sellerController');
const { authenticate, isSeller } = require('../middleware/auth');

// Tudo aqui é do PRÓPRIO vendedor (a identidade vem do token, nunca do pedido).
router.use(authenticate, isSeller);

router.get('/dashboard', ctrl.dashboard);
// '/products/health' TEM de vir antes de '/products/:id/analytics'
router.get('/products/health', ctrl.productsHealth);
router.get('/products/:id/analytics', ctrl.productAnalyticsOwner);

module.exports = router;
