'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/walletController');
const { authenticate, isAdmin, isSeller } = require('../middleware/auth');

// ─── ME ──────────────────────────────────────────────────────────
router.get('/me', authenticate, ctrl.myWallet);

// ─── SELLER: comissão de plataforma ────────────────────────────────
router.post('/commission/pay', authenticate, isSeller, ctrl.payCommission);
router.get('/commission/:id', authenticate, ctrl.commissionStatus);
router.post('/commission/:id/cancel', authenticate, isSeller, ctrl.cancelCommissionPayment);

// ─── ADMIN ──────────────────────────────────────────────────────────
router.get('/admin/commission-payments', authenticate, isAdmin, ctrl.adminListCommissionPayments);
router.get('/admin/gateway/validate', authenticate, isAdmin, ctrl.adminValidateGateway);

module.exports = router;
