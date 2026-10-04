'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/walletController');
const flow = require('../controllers/walletFlowController');
const { authenticate, isAdmin, isSeller } = require('../middleware/auth');
const { adminActionLimiter, walletMoneyLimiter, walletLookupLimiter } = require('../middleware/rateLimiter');
const { requireFeature } = require('../middleware/featureGate');

const pay = requireFeature('ENABLE_PAYMENTS');

// ─── ME: saldo, extracto, resumo, recibos ───────────────────────────
router.get('/me', authenticate, ctrl.myWallet);                               // saldo + extracto (aceita ?type=&status=&direction=&from=&to=&q=)
router.get('/summary', authenticate, flow.summary);                           // saldo, limites, pendentes, entradas/saídas do mês
router.get('/statement/export', authenticate, flow.exportStatement);          // CSV do extracto (mesmos filtros)
router.get('/transactions/:id', authenticate, flow.receipt);                  // recibo de um movimento

// ─── ME: PIN da wallet ─────────────────────────────────────────────
router.post('/pin', authenticate, walletMoneyLimiter, flow.setPin);           // definir (1.ª vez) ou alterar (com currentPin)
router.post('/pin/reset', authenticate, walletMoneyLimiter, flow.resetPin);   // esqueceu o PIN: confirma com a palavra-passe

// ─── ME: depósitos ─────────────────────────────────────────────────
router.post('/deposit/stk', authenticate, walletMoneyLimiter, pay, flow.depositStk);        // carregar via M-Pesa/e-Mola (STK push)
router.post('/deposit/manual', authenticate, walletMoneyLimiter, pay, flow.depositManual);  // carregar com comprovativo (aprovação do admin)
router.get('/deposits', authenticate, flow.listDeposits);
router.get('/deposit/:id', authenticate, flow.getDeposit);                                  // estado (polling do STK)
router.post('/deposit/:id/cancel', authenticate, walletMoneyLimiter, flow.cancelDeposit);

// ─── ME: levantamentos ─────────────────────────────────────────────
router.post('/withdraw', authenticate, walletMoneyLimiter, pay, flow.withdraw);
router.get('/withdrawals', authenticate, flow.listWithdrawals);
router.post('/withdraw/:id/cancel', authenticate, walletMoneyLimiter, flow.cancelWithdrawal);

// ─── ME: transferências entre utilizadores ─────────────────────────
router.get('/recipients/search', authenticate, walletLookupLimiter, flow.recipientSearch);
router.get('/recipients/recent', authenticate, flow.recipientsRecent);
router.post('/transfer', authenticate, walletMoneyLimiter, pay, flow.transfer);

// ─── ME: pedir dinheiro ────────────────────────────────────────────
router.post('/requests', authenticate, walletMoneyLimiter, flow.requestCreate);
router.get('/requests', authenticate, flow.requestList);                      // ?box=received (por defeito) | sent
router.post('/requests/:id/pay', authenticate, walletMoneyLimiter, pay, flow.requestPay);
router.post('/requests/:id/decline', authenticate, walletMoneyLimiter, flow.requestDecline);
router.post('/requests/:id/cancel', authenticate, walletMoneyLimiter, flow.requestCancel);

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
// Depósitos / levantamentos / visão geral
router.get('/admin/overview', authenticate, isAdmin, adminActionLimiter, flow.adminOverview);
router.get('/admin/deposits', authenticate, isAdmin, adminActionLimiter, flow.adminDeposits);
router.post('/admin/deposits/:id/approve', authenticate, isAdmin, adminActionLimiter, flow.adminApproveDeposit);
router.post('/admin/deposits/:id/reject', authenticate, isAdmin, adminActionLimiter, flow.adminRejectDeposit);
router.get('/admin/withdrawals', authenticate, isAdmin, adminActionLimiter, flow.adminWithdrawals);
router.post('/admin/withdrawals/:id/pay', authenticate, isAdmin, adminActionLimiter, flow.adminPayWithdrawal);
router.post('/admin/withdrawals/:id/reject', authenticate, isAdmin, adminActionLimiter, flow.adminRejectWithdrawal);
router.post('/admin/pin/clear', authenticate, isAdmin, adminActionLimiter, flow.adminClearPin);

module.exports = router;
