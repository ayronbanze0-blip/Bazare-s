'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.use(authenticate, isAdmin);

router.get('/overview', ctrl.overview);
router.get('/users', ctrl.listUsers);
router.patch('/users/:id/toggle', ctrl.toggleUser);
router.patch('/users/:id/verify-seller', ctrl.verifySeller);
router.post('/users/:id/message', ctrl.messageUser);
router.post('/broadcast', ctrl.broadcast);
router.get('/products', ctrl.listProducts);
router.patch('/products/:id/toggle', ctrl.toggleProduct);
router.get('/orders', ctrl.listOrders);
router.get('/reports', ctrl.listReports);
router.patch('/reports/:id/resolve', ctrl.resolveReport);
router.get('/analytics/reports', ctrl.reports);
router.get('/audit-logs', ctrl.auditLogs);

module.exports = router;
