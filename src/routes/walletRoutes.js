'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/walletController');
const { authenticate, isAdmin, isSeller } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { upload } = require('../services/uploadService');

// ─── ME ──────────────────────────────────────────────────────────
router.get('/me', authenticate, ctrl.myWallet);
router.post('/transfer', authenticate, ctrl.transfer);

router.post('/deposits', authenticate, uploadLimiter, upload.single('proof'), ctrl.requestDeposit);
router.get('/deposits', authenticate, ctrl.myDeposits);

router.post('/withdrawals', authenticate, ctrl.requestWithdrawal);
router.get('/withdrawals', authenticate, ctrl.myWithdrawals);

// ─── SELLER: comissão de plataforma ────────────────────────────────
router.post('/commission/pay', authenticate, isSeller, ctrl.payCommission);
router.get('/commission/:id', authenticate, ctrl.commissionStatus);

// ─── ADMIN ──────────────────────────────────────────────────────────
router.get('/admin/deposits', authenticate, isAdmin, ctrl.adminListDeposits);
router.patch('/admin/deposits/:id/approve', authenticate, isAdmin, ctrl.adminApproveDeposit);
router.patch('/admin/deposits/:id/reject', authenticate, isAdmin, ctrl.adminRejectDeposit);

router.get('/admin/withdrawals', authenticate, isAdmin, ctrl.adminListWithdrawals);
router.patch('/admin/withdrawals/:id/pay', authenticate, isAdmin, ctrl.adminMarkWithdrawalPaid);
router.patch('/admin/withdrawals/:id/reject', authenticate, isAdmin, ctrl.adminRejectWithdrawal);

router.get('/admin/commission-payments', authenticate, isAdmin, ctrl.adminListCommissionPayments);
router.get('/admin/gateway/validate', authenticate, isAdmin, ctrl.adminValidateGateway);

module.exports = router;
