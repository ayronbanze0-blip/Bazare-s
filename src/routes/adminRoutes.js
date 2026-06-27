'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.use(authenticate, isAdmin);

router.get('/overview', ctrl.overview);

// Utilizadores
router.get('/users', ctrl.listUsers);
router.patch('/users/:id/toggle', ctrl.toggleUser);
router.patch('/users/:id/verify-seller', ctrl.verifySeller);
router.post('/users/:id/message', ctrl.messageUser);
router.post('/broadcast', ctrl.broadcast);

// Produtos
router.get('/products', ctrl.listProducts);
router.patch('/products/:id/toggle', ctrl.toggleProduct);
router.patch('/products/:id/featured', ctrl.toggleFeatured);

// Encomendas
router.get('/orders', ctrl.listOrders);

// Denúncias
router.get('/reports', ctrl.listReports);
router.patch('/reports/:id/resolve', ctrl.resolveReport);

// Financeiro
router.patch('/bazars/:bazarId/fee-rate', ctrl.setBazarFeeRate);

// Analytics & Auditoria
router.get('/analytics/reports', ctrl.reports);
router.get('/audit-logs', ctrl.auditLogs);

module.exports = router;
