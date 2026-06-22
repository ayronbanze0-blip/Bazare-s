'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/financeController');
const { authenticate, isSeller, isAdmin } = require('../middleware/auth');

router.get('/me', authenticate, isSeller, ctrl.myFinance);
router.post('/me/submit-payment', authenticate, isSeller, ctrl.submitPayment);
router.post('/admin/:bazarId/confirm-payment', authenticate, isAdmin, ctrl.confirmPayment);
router.patch('/admin/:bazarId/adjust-fee', authenticate, isAdmin, ctrl.adjustFee);
router.patch('/admin/:bazarId/fee-rate', authenticate, isAdmin, ctrl.setFeeRate);
router.get('/admin/overview', authenticate, isAdmin, ctrl.platformFinance);
router.get('/admin/transactions', authenticate, isAdmin, ctrl.allTransactions);

module.exports = router;
