'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/walletController');
const { authenticate, isAdmin, isSeller } = require('../middleware/auth');
const { adminActionLimiter } = require('../middleware/rateLimiter');
const { requireFeature } = require('../middleware/featureGate');

// ─── ME ──────────────────────────────────────────────────────────
router.get('/me', authenticate, ctrl.myWallet);

// ─── SELLER: comissão de plataforma ────────────────────────────────
router.post('/commission/pay', authenticate, isSeller, requireFeature('ENABLE_PAYMENTS'), ctrl.payCommission);
router.get('/commission/:id', authenticate, ctrl.commissionStatus);
router.post('/commission/:id/cancel', authenticate, isSeller, ctrl.cancelCommissionPayment);

// ─── ADMIN ──────────────────────────────────────────────────────────
router.get('/admin/commission-payments', authenticate, isAdmin, adminActionLimiter, ctrl.adminListCommissionPayments);
router.get('/admin/gateway/validate', authenticate, isAdmin, adminActionLimiter, ctrl.adminValidateGateway);
// Ledger: reconciliação (só leitura) e ajuste (novo movimento AJUSTE_ADMIN + AuditLog, idempotente)
router.get('/admin/ledger/reconcile', authenticate, isAdmin, adminActionLimiter, ctrl.adminReconcileLedger);
router.post('/admin/ledger/adjust', authenticate, isAdmin, adminActionLimiter, ctrl.adminAdjustWallet);

module.exports = router;
