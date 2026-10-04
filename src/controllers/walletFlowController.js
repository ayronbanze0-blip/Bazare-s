'use strict';

/**
 * Wallet — controllers dos fluxos completos. Finos de propósito: validação de entrada, auditoria,
 * mapeamento de erros. Toda a lógica financeira está em services/walletFlowService.js.
 */

const { ok, created, errorBody, badRequest, serverError } = require('../utils/response');
const logger = require('../utils/logger');
const audit = require('../services/auditService');
const flow = require('../services/walletFlowService');
const rules = require('../services/walletRules');

const run = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err && err.name === 'WalletFlowError') {
      return res.status(err.status).json(errorBody(res, err.code, err.message, err.extra ? { details: err.extra } : {}));
    }
    if (err && err.name === 'InsufficientFundsError') return badRequest(res, err.message);
    logger.error(`[WalletFlow.${label}] ${err && err.message}`);
    // Nunca devolver err.message (pode expor detalhes de BD/gateway).
    return serverError(res, 'Não foi possível concluir a operação.');
  }
};

const body = (req) => req.body || {};
const msg = (duplicate, text) => (duplicate ? 'Pedido já tinha sido registado (repetição ignorada).' : text);

// ─── Resumo, extracto, recibo ─────────────────────────────────────
const summary = run('summary', async (req, res) => ok(res, await flow.getSummary(req.user.id)));

const statement = run('statement', async (req, res) => {
  const { page, limit, type, status, direction, from, to, q } = req.query;
  return ok(res, await flow.getStatementFiltered(req.user.id, { page, limit, type, status, direction, from, to, q }));
});

const receipt = run('receipt', async (req, res) => ok(res, await flow.getReceipt(req.user.id, req.params.id)));

const exportStatement = run('export', async (req, res) => {
  const { type, status, direction, from, to, q } = req.query;
  const csv = await flow.exportStatementCsv(req.user.id, { type, status, direction, from, to, q });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="extracto-bazares-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(csv);
});

// ─── PIN ──────────────────────────────────────────────────────────
const setPin = run('setPin', async (req, res) => {
  const { pin, currentPin } = body(req);
  const r = await flow.setOrChangePin(req.user.id, { pin, currentPin });
  audit.record(req, r.changed ? 'WALLET_PIN_CHANGED' : 'WALLET_PIN_SET', { entity: 'Wallet' });
  return ok(res, { hasPin: true }, r.changed ? 'PIN alterado.' : 'PIN definido.');
});

const resetPin = run('resetPin', async (req, res) => {
  const { password, pin } = body(req);
  await flow.resetPinWithPassword(req.user.id, { password, pin });
  audit.record(req, 'WALLET_PIN_RESET', { entity: 'Wallet' });
  return ok(res, { hasPin: true }, 'PIN reposto.');
});

// ─── Depósitos ────────────────────────────────────────────────────
const depositStk = run('depositStk', async (req, res) => {
  const { amount, msisdn, idempotencyKey } = body(req);
  const r = await flow.createStkDeposit(req.user, { amount, msisdn, idempotencyKey });
  if (!r.duplicate) audit.record(req, 'WALLET_DEPOSIT_STK_STARTED', { entity: 'DepositRequest', entityId: r.deposit.id, newValue: { amount: r.deposit.amount } });
  return ok(res, r, msg(r.duplicate, 'Pedido enviado para o teu telemóvel. Introduz o PIN do M-Pesa/e-Mola para confirmar.'));
});

const depositManual = run('depositManual', async (req, res) => {
  const { amount, method, reference, proofUrl, idempotencyKey } = body(req);
  const r = await flow.createManualDeposit(req.user, { amount, method, reference, proofUrl, idempotencyKey });
  if (!r.duplicate) audit.record(req, 'WALLET_DEPOSIT_MANUAL_SUBMITTED', { entity: 'DepositRequest', entityId: r.deposit.id, newValue: { amount: r.deposit.amount } });
  return created(res, r, msg(r.duplicate, 'Depósito enviado para aprovação.'));
});

const listDeposits = run('listDeposits', async (req, res) => ok(res, await flow.listMyDeposits(req.user.id, req.query)));
const getDeposit = run('getDeposit', async (req, res) => ok(res, { deposit: await flow.getMyDeposit(req.user.id, req.params.id) }));
const cancelDeposit = run('cancelDeposit', async (req, res) => {
  await flow.cancelMyDeposit(req.user.id, req.params.id);
  return ok(res, {}, 'Depósito cancelado.');
});

// ─── Levantamentos ────────────────────────────────────────────────
const withdraw = run('withdraw', async (req, res) => {
  const { amount, destination, method, pin, idempotencyKey } = body(req);
  const r = await flow.requestWithdrawal(req.user, { amount, destination, method, pin, idempotencyKey });
  if (!r.duplicate) audit.record(req, 'WALLET_WITHDRAWAL_REQUESTED', { entity: 'WithdrawalRequest', entityId: r.withdrawal.id, newValue: { amount: r.withdrawal.amount, method: r.withdrawal.method } });
  return created(res, r, msg(r.duplicate, 'Levantamento pedido. O valor ficou retido até ser pago.'));
});

const listWithdrawals = run('listWithdrawals', async (req, res) => ok(res, await flow.listMyWithdrawals(req.user.id, req.query)));
const cancelWithdrawal = run('cancelWithdrawal', async (req, res) => {
  const r = await flow.cancelMyWithdrawal(req.user.id, req.params.id);
  audit.record(req, 'WALLET_WITHDRAWAL_CANCELLED', { entity: 'WithdrawalRequest', entityId: req.params.id });
  return ok(res, r, 'Levantamento cancelado e valor devolvido.');
});

// ─── Transferências ───────────────────────────────────────────────
const recipientSearch = run('recipientSearch', async (req, res) => ok(res, { users: await flow.searchRecipients(req.user.id, req.query.q) }));
const recipientsRecent = run('recipientsRecent', async (req, res) => ok(res, { users: await flow.recentRecipients(req.user.id) }));

const transfer = run('transfer', async (req, res) => {
  const { toUserId, amount, note, pin, idempotencyKey } = body(req);
  const r = await flow.transferP2P(req.user, { toUserId, amount, note, pin, idempotencyKey });
  if (!r.duplicate) audit.record(req, 'WALLET_TRANSFER', { entity: 'Wallet', entityId: r.reference, newValue: { to: r.recipient.id, amount: r.amount } });
  return ok(res, r, msg(r.duplicate, `Enviaste ${r.amount.toLocaleString('pt-MZ')} MT para ${r.recipient.name}.`));
});

// ─── Pedidos de dinheiro ──────────────────────────────────────────
const requestCreate = run('requestCreate', async (req, res) => {
  const { payerId, amount, note } = body(req);
  const r = await flow.createMoneyRequest(req.user, { payerId, amount, note });
  return created(res, { request: r }, 'Pedido enviado.');
});
const requestList = run('requestList', async (req, res) => ok(res, await flow.listMoneyRequests(req.user.id, { box: req.query.box === 'sent' ? 'sent' : 'received', page: req.query.page, limit: req.query.limit })));
const requestPay = run('requestPay', async (req, res) => {
  const r = await flow.payMoneyRequest(req.user, req.params.id, body(req).pin);
  audit.record(req, 'WALLET_MONEY_REQUEST_PAID', { entity: 'MoneyRequest', entityId: req.params.id, newValue: { amount: r.amount } });
  return ok(res, r, 'Pedido pago.');
});
const requestDecline = run('requestDecline', async (req, res) => { await flow.closeMoneyRequest(req.user.id, req.params.id, 'decline'); return ok(res, {}, 'Pedido recusado.'); });
const requestCancel = run('requestCancel', async (req, res) => { await flow.closeMoneyRequest(req.user.id, req.params.id, 'cancel'); return ok(res, {}, 'Pedido cancelado.'); });

// ─── ADMIN ────────────────────────────────────────────────────────
const adminOverview = run('adminOverview', async (req, res) => ok(res, await flow.adminOverview()));
const adminDeposits = run('adminDeposits', async (req, res) => ok(res, await flow.adminList('depositRequest', req.query)));
const adminWithdrawals = run('adminWithdrawals', async (req, res) => ok(res, await flow.adminList('withdrawalRequest', req.query)));

const adminApproveDeposit = run('adminApproveDeposit', async (req, res) => {
  const r = await flow.adminApproveDeposit(req.user.id, req.params.id);
  audit.record(req, 'ADMIN_DEPOSIT_APPROVED', { entity: 'DepositRequest', entityId: req.params.id, newValue: { userId: r.userId, amount: r.amount } });
  return ok(res, {}, 'Depósito aprovado e saldo creditado.');
});
const adminRejectDeposit = run('adminRejectDeposit', async (req, res) => {
  const r = await flow.adminRejectDeposit(req.user.id, req.params.id, body(req).reason);
  audit.record(req, 'ADMIN_DEPOSIT_REJECTED', { entity: 'DepositRequest', entityId: req.params.id, newValue: { userId: r.userId, amount: r.amount, reason: rules.cleanText(body(req).reason, 200) } });
  return ok(res, {}, 'Depósito rejeitado.');
});
const adminPayWithdrawal = run('adminPayWithdrawal', async (req, res) => {
  const r = await flow.adminPayWithdrawal(req.user.id, req.params.id, body(req).notes);
  audit.record(req, 'ADMIN_WITHDRAWAL_PAID', { entity: 'WithdrawalRequest', entityId: req.params.id, newValue: { userId: r.userId, amount: r.amount } });
  return ok(res, {}, 'Levantamento marcado como pago.');
});
const adminRejectWithdrawal = run('adminRejectWithdrawal', async (req, res) => {
  const r = await flow.adminRejectWithdrawal(req.user.id, req.params.id, body(req).reason);
  audit.record(req, 'ADMIN_WITHDRAWAL_REJECTED', { entity: 'WithdrawalRequest', entityId: req.params.id, newValue: { userId: r.userId, amount: r.amount, reason: rules.cleanText(body(req).reason, 200) } });
  return ok(res, {}, 'Levantamento rejeitado e valor devolvido.');
});
const adminClearPin = run('adminClearPin', async (req, res) => {
  const userId = body(req).userId;
  if (typeof userId !== 'string' || !userId || userId.length > 64) return badRequest(res, 'userId inválido.');
  await flow.adminClearPin(userId);
  audit.record(req, 'ADMIN_WALLET_PIN_CLEARED', { entity: 'Wallet', entityId: userId });
  return ok(res, {}, 'PIN removido.');
});

module.exports = {
  summary, statement, receipt, exportStatement, setPin, resetPin,
  depositStk, depositManual, listDeposits, getDeposit, cancelDeposit,
  withdraw, listWithdrawals, cancelWithdrawal,
  recipientSearch, recipientsRecent, transfer,
  requestCreate, requestList, requestPay, requestDecline, requestCancel,
  adminOverview, adminDeposits, adminWithdrawals, adminApproveDeposit, adminRejectDeposit,
  adminPayWithdrawal, adminRejectWithdrawal, adminClearPin
};
