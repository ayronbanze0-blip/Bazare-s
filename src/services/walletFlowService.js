'use strict';

/**
 * Wallet — fluxos completos (depósito, levantamento, transferência, pedidos de dinheiro, PIN, extracto).
 *
 * Princípios (iguais aos de walletService/ledgerService, que continuam a ser o único sítio que mexe no saldo):
 *  - Todo o movimento de saldo passa por walletService.credit/debit dentro de uma $transaction.
 *  - "Claims" atómicos (updateMany com condição de estado) antes de mexer em dinheiro: duplo clique,
 *    webhooks repetidos e aprovações concorrentes só actuam uma vez.
 *  - Limites diários verificados DENTRO da transacção, sob lock consultivo da wallet.
 *  - O PIN é verificado FORA da transacção, para o contador de tentativas falhadas persistir.
 *  - Levantamento: o valor sai do saldo no pedido (fica "retido", movimento PENDENTE). Se for rejeitado ou
 *    cancelado, o movimento original passa a REVERTIDA e entra um crédito ESTORNO — o ledger reconcilia sempre.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const walletService = require('./walletService');
const zumboPay = require('./zumboPayService');
const notifSvc = require('./notificationService');
const blockService = require('./blockService');
const ledger = require('./ledgerService');
const rules = require('./walletRules');
const { classifyGatewayError } = require('./gatewayErrors');

const STK_INFLIGHT_EXPIRY_MS = (parseInt(process.env.STK_INFLIGHT_EXPIRY_MIN) || 6) * 60 * 1000;
const MAX_PENDING_MANUAL_DEPOSITS = 5;
const MAX_PENDING_WITHDRAWALS = 3;
const MAX_PENDING_MONEY_REQUESTS = 10;
const fmt = (n) => Number(n).toLocaleString('pt-MZ');

class WalletFlowError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extra = null) {
    super(message);
    this.name = 'WalletFlowError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const lockWallet = (tx, walletId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + walletId}))`;
const isUniqueViolation = (err) => err && err.code === 'P2002';

// ═════════════════════════════════════════════════════════════════
// PIN
// ═════════════════════════════════════════════════════════════════
const hasPin = async (userId) => {
  const w = await walletService.getOrCreateWallet(prisma, userId);
  return Boolean(w.pinHash);
};

/** Verifica o PIN (fora de transacção). Lança WalletFlowError se não existir, estiver bloqueado ou errado. */
const verifyPin = async (userId, pin) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  if (!wallet.pinHash) {
    throw new WalletFlowError('Define primeiro o PIN da tua wallet.', 400, 'PIN_NOT_SET');
  }
  const lockedMin = rules.pinLockRemainingMin(wallet.pinLockedUntil);
  if (lockedMin > 0) {
    throw new WalletFlowError(`PIN bloqueado por tentativas falhadas. Tenta de novo daqui a ${lockedMin} min.`, 429, 'PIN_LOCKED', { retryAfterMin: lockedMin });
  }
  if (!rules.isValidPinFormat(pin)) {
    throw new WalletFlowError('Introduz o teu PIN (4 a 6 dígitos).', 400, 'PIN_INVALID');
  }

  const match = await bcrypt.compare(pin, wallet.pinHash);
  if (match) {
    if (wallet.pinFailedAttempts > 0 || wallet.pinLockedUntil) {
      await prisma.wallet.update({ where: { id: wallet.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
    }
    return true;
  }

  const updated = await prisma.wallet.update({ where: { id: wallet.id }, data: { pinFailedAttempts: { increment: 1 } } });
  if (updated.pinFailedAttempts >= rules.PIN_MAX_ATTEMPTS) {
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + rules.PIN_LOCK_MINUTES * 60 * 1000) }
    });
    notifSvc.push(userId, {
      type: 'WARNING', title: 'PIN da wallet bloqueado',
      message: `Houve ${rules.PIN_MAX_ATTEMPTS} tentativas falhadas. A wallet está bloqueada durante ${rules.PIN_LOCK_MINUTES} minutos.`,
      link: '/wallet'
    });
    throw new WalletFlowError(`PIN errado demasiadas vezes. Wallet bloqueada durante ${rules.PIN_LOCK_MINUTES} minutos.`, 429, 'PIN_LOCKED', { retryAfterMin: rules.PIN_LOCK_MINUTES });
  }
  const left = rules.PIN_MAX_ATTEMPTS - updated.pinFailedAttempts;
  throw new WalletFlowError(`PIN incorrecto. Restam ${left} tentativa${left === 1 ? '' : 's'}.`, 400, 'PIN_INVALID', { attemptsLeft: left });
};

const assertPinAcceptable = (pin) => {
  if (!rules.isValidPinFormat(pin)) throw new WalletFlowError('O PIN deve ter 4 a 6 dígitos.');
  if (rules.isWeakPin(pin)) throw new WalletFlowError('PIN demasiado fácil (ex.: 1234 ou 1111). Escolhe outro.');
};

/** Define o PIN (1.ª vez) ou altera-o (exige o PIN actual). */
const setOrChangePin = async (userId, { pin, currentPin }) => {
  assertPinAcceptable(pin);
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  if (wallet.pinHash) {
    if (!currentPin) throw new WalletFlowError('Indica o PIN actual para o alterar.', 400, 'PIN_CURRENT_REQUIRED');
    await verifyPin(userId, currentPin);
  }
  const pinHash = await bcrypt.hash(pin, 10);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { pinHash, pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null }
  });
  notifSvc.push(userId, {
    type: 'INFO', title: wallet.pinHash ? 'PIN da wallet alterado' : 'PIN da wallet definido',
    message: 'Se não foste tu, contacta o suporte de imediato.', link: '/wallet'
  });
  return { changed: Boolean(wallet.pinHash) };
};

/** PIN esquecido: confirma a palavra-passe da conta e define um novo PIN. */
const resetPinWithPassword = async (userId, { password, pin }) => {
  assertPinAcceptable(pin);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user || !user.passwordHash) {
    throw new WalletFlowError('Esta conta não tem palavra-passe (login social). Contacta o suporte para repor o PIN.', 400, 'NO_PASSWORD');
  }
  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new WalletFlowError('Palavra-passe incorrecta.', 400, 'PASSWORD_INVALID');
  }
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { pinHash: await bcrypt.hash(pin, 10), pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null }
  });
  notifSvc.push(userId, { type: 'INFO', title: 'PIN da wallet reposto', message: 'O PIN foi reposto com a tua palavra-passe.', link: '/wallet' });
  return {};
};

/** Admin: remove o PIN (o utilizador define um novo). */
const adminClearPin = async (userId) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { pinHash: null, pinSetAt: null, pinFailedAttempts: 0, pinLockedUntil: null }
  });
  notifSvc.push(userId, { type: 'INFO', title: 'PIN da wallet removido', message: 'Define um novo PIN para voltares a levantar e transferir.', link: '/wallet' });
};

// ═════════════════════════════════════════════════════════════════
// Limites e resumo
// ═════════════════════════════════════════════════════════════════
const LIVE_STATUSES = ['CONCLUIDA', 'PENDENTE'];

const sumToday = async (client, walletId, type, now = new Date()) => {
  const r = await client.walletTransaction.aggregate({
    where: { walletId, type, status: { in: LIVE_STATUSES }, createdAt: { gte: rules.startOfDayMaputo(now) } },
    _sum: { amount: true }
  });
  return r._sum.amount || 0;
};

const getSummary = async (userId) => {
  const now = new Date();
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  const limits = rules.getLimits();

  const [withdrawnToday, transferredToday, monthGroups, pendingW, pendingDeps, pendingReqs] = await Promise.all([
    sumToday(prisma, wallet.id, 'DEBITO_LEVANTAMENTO', now),
    sumToday(prisma, wallet.id, 'TRANSFERENCIA_ENVIADA', now),
    prisma.walletTransaction.groupBy({
      by: ['type', 'referenceType'],
      where: { walletId: wallet.id, status: { in: LIVE_STATUSES }, createdAt: { gte: rules.startOfMonthMaputo(now) } },
      _sum: { amount: true }
    }),
    prisma.withdrawalRequest.aggregate({ where: { userId, status: 'PENDENTE' }, _sum: { amount: true }, _count: true }),
    prisma.depositRequest.count({ where: { userId, status: { in: ['PENDENTE', 'PROCESSANDO'] } } }),
    prisma.moneyRequest.count({ where: { payerId: userId, status: 'PENDENTE', expiresAt: { gt: now } } })
  ]);

  let monthIn = 0;
  let monthOut = 0;
  for (const g of monthGroups) {
    if (g.type === 'ESTORNO') continue; // o débito original já foi excluído (REVERTIDA)
    const s = ledger.signedAmount({ type: g.type, referenceType: g.referenceType, amount: g._sum.amount || 0 });
    if (s === null) continue;
    if (s >= 0) monthIn += s; else monthOut += -s;
  }

  const lockedMin = rules.pinLockRemainingMin(wallet.pinLockedUntil, now);
  return {
    balance: wallet.balance,
    hasPin: Boolean(wallet.pinHash),
    pinLockedMinutes: lockedMin,
    month: { in: rules.round2(monthIn), out: rules.round2(monthOut) },
    pending: {
      withdrawals: pendingW._count || 0,
      withdrawalsAmount: pendingW._sum.amount || 0,
      deposits: pendingDeps,
      moneyRequestsToPay: pendingReqs
    },
    limits: {
      ...limits,
      withdrawnToday, transferredToday,
      withdrawRemainingToday: Math.max(0, rules.round2(limits.dailyWithdraw - withdrawnToday)),
      transferRemainingToday: Math.max(0, rules.round2(limits.dailyTransfer - transferredToday))
    },
    gatewayAvailable: zumboPay.isConfigured()
  };
};

// ═════════════════════════════════════════════════════════════════
// Extracto, recibo, export
// ═════════════════════════════════════════════════════════════════
const IN_TYPES = [...ledger.CREDIT_TYPES];
const OUT_TYPES = [...ledger.DEBIT_TYPES];

const buildStatementWhere = (walletId, { type, status, direction, from, to, q } = {}) => {
  const where = { walletId };
  if (type) where.type = type;
  if (status) where.status = status;
  const and = [];
  if (direction === 'IN') {
    and.push({ OR: [{ type: { in: IN_TYPES } }, { type: 'AJUSTE_ADMIN', referenceType: 'ADJUSTMENT_CREDIT' }] });
  } else if (direction === 'OUT') {
    and.push({ OR: [{ type: { in: OUT_TYPES } }, { type: 'AJUSTE_ADMIN', referenceType: 'ADJUSTMENT_DEBIT' }] });
  }
  const f = rules.parseDateParam(from);
  const t = rules.parseDateParam(to, { endOfDay: true });
  if (f || t) where.createdAt = { ...(f && { gte: f }), ...(t && { lte: t }) };
  const search = rules.cleanText(q, 60);
  if (search) and.push({ description: { contains: search, mode: 'insensitive' } });
  if (and.length) where.AND = and;
  return where;
};

const VALID_TX_TYPES = new Set(['CREDITO_DEPOSITO', 'DEBITO_LEVANTAMENTO', 'TRANSFERENCIA_ENVIADA', 'TRANSFERENCIA_RECEBIDA', 'DEBITO_COMISSAO', 'CREDITO_COMISSAO', 'AJUSTE_ADMIN', 'ESTORNO', 'PAGAMENTO_COMPRA', 'RECEBIMENTO_VENDA', 'REEMBOLSO_COMPRA', 'REEMBOLSO_VENDA']);
const VALID_TX_STATUS = new Set(['CONCLUIDA', 'PENDENTE', 'REJEITADA', 'REVERTIDA']);

const sanitizeFilters = (f = {}) => ({
  type: VALID_TX_TYPES.has(f.type) ? f.type : undefined,
  status: VALID_TX_STATUS.has(f.status) ? f.status : undefined,
  direction: ['IN', 'OUT'].includes(f.direction) ? f.direction : undefined,
  from: f.from, to: f.to, q: f.q
});

const getStatementFiltered = async (userId, { page = 1, limit = 30, ...filters } = {}) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  const take = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
  const pageN = Math.max(parseInt(page) || 1, 1);
  const where = buildStatementWhere(wallet.id, sanitizeFilters(filters));
  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: (pageN - 1) * take }),
    prisma.walletTransaction.count({ where })
  ]);
  return {
    balance: wallet.balance,
    transactions: rows.map((t) => ({ ...t, direction: rules.directionOf(t) })),
    meta: { total, page: pageN, limit: take, pages: Math.ceil(total / take) }
  };
};

const exportStatementCsv = async (userId, filters = {}) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  const rows = await prisma.walletTransaction.findMany({
    where: buildStatementWhere(wallet.id, sanitizeFilters(filters)),
    orderBy: { createdAt: 'desc' },
    take: 5000
  });
  return rules.statementToCsv(rows);
};

/** Recibo/detalhe de um movimento (só do próprio dono). */
const getReceipt = async (userId, txId) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  const tx = await prisma.walletTransaction.findFirst({ where: { id: txId, walletId: wallet.id } });
  if (!tx) throw new WalletFlowError('Movimento não encontrado.', 404, 'NOT_FOUND');

  const receipt = {
    code: tx.id.slice(0, 8).toUpperCase(),
    transaction: { ...tx, direction: rules.directionOf(tx) },
    counterparty: null,
    deposit: null,
    withdrawal: null
  };

  if (['TRANSFER', 'MONEY_REQUEST'].includes(tx.referenceType) && tx.referenceId) {
    const oppositeType = tx.type === 'TRANSFERENCIA_ENVIADA' ? 'TRANSFERENCIA_RECEBIDA' : 'TRANSFERENCIA_ENVIADA';
    const other = await prisma.walletTransaction.findFirst({
      where: { referenceType: tx.referenceType, referenceId: tx.referenceId, type: oppositeType, walletId: { not: wallet.id } },
      include: { wallet: { select: { user: { select: { id: true, name: true, username: true, avatarUrl: true } } } } }
    });
    receipt.counterparty = other?.wallet?.user || null;
  } else if (tx.referenceType === 'DEPOSIT' && tx.referenceId) {
    const d = await prisma.depositRequest.findFirst({ where: { id: tx.referenceId, userId }, select: { id: true, method: true, reference: true, status: true, createdAt: true } });
    receipt.deposit = d;
  } else if (['WITHDRAWAL', 'WITHDRAWAL_REFUND'].includes(tx.referenceType) && tx.referenceId) {
    const w = await prisma.withdrawalRequest.findFirst({ where: { id: tx.referenceId, userId }, select: { id: true, method: true, destination: true, status: true, rejectReason: true, createdAt: true, reviewedAt: true } });
    if (w) receipt.withdrawal = { ...w, destination: rules.maskPhone(w.destination) };
  }
  return receipt;
};

// ═════════════════════════════════════════════════════════════════
// Depósitos
// ═════════════════════════════════════════════════════════════════
const depositIsStk = (d) => Boolean(d.msisdn);

/** Marca como FALHADA um STK parado há demasiado tempo (sem resposta do operador). */
const expireStaleStk = async (deposit) => {
  if (deposit.status !== 'PROCESSANDO' || !depositIsStk(deposit)) return deposit;
  if (Date.now() - new Date(deposit.createdAt).getTime() < STK_INFLIGHT_EXPIRY_MS) return deposit;
  const r = await prisma.depositRequest.updateMany({
    where: { id: deposit.id, status: 'PROCESSANDO' },
    data: { status: 'FALHADA', rejectReason: 'Expirado — sem confirmação do operador dentro do tempo limite.' }
  });
  // Se o webhook chegar mais tarde com sucesso, o dinheiro entra na mesma (ver settleStkDeposit).
  return r.count ? { ...deposit, status: 'FALHADA', rejectReason: 'Expirado — sem confirmação do operador dentro do tempo limite.' } : prisma.depositRequest.findUnique({ where: { id: deposit.id } });
};

const publicDeposit = (d) => ({
  id: d.id, amount: d.amount, method: d.method, status: d.status,
  kind: depositIsStk(d) ? 'STK' : 'MANUAL',
  reference: d.reference, proofUrl: d.proofUrl,
  msisdn: rules.maskPhone(d.msisdn), rejectReason: d.rejectReason,
  createdAt: d.createdAt, reviewedAt: d.reviewedAt
});

const createStkDeposit = async (user, { amount, msisdn, idempotencyKey }) => {
  const limits = rules.getLimits();
  const a = rules.parseAmount(amount, { min: limits.minDeposit, max: limits.maxDeposit });
  if (!a.ok) throw new WalletFlowError(a.error);
  if (!zumboPay.isConfigured()) {
    throw new WalletFlowError('O carregamento automático via M-Pesa/e-Mola ainda não está disponível. Usa o depósito com comprovativo.', 400, 'GATEWAY_UNAVAILABLE');
  }
  const normalized = zumboPay.normalizeMsisdn(msisdn);
  const method = zumboPay.detectMethod(msisdn);
  if (!normalized || !method) throw new WalletFlowError('Número inválido. Usa um número M-Pesa (84/85) ou e-Mola (86/87).');

  if (idempotencyKey) {
    if (!rules.isValidIdempotencyKey(idempotencyKey)) throw new WalletFlowError('idempotencyKey inválida.');
    const prev = await prisma.depositRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
    if (prev) return { deposit: publicDeposit(prev), duplicate: true };
  }

  const inFlight = await prisma.depositRequest.findFirst({ where: { userId: user.id, status: 'PROCESSANDO', msisdn: { not: null } } });
  if (inFlight) {
    const fresh = await expireStaleStk(inFlight);
    if (fresh.status === 'PROCESSANDO') {
      throw new WalletFlowError('Já tens um carregamento em processamento. Confirma-o no telemóvel ou cancela-o para tentar de novo.', 400, 'DEPOSIT_IN_FLIGHT', { pendingDepositId: inFlight.id });
    }
  }

  let deposit;
  try {
    deposit = await prisma.depositRequest.create({
      data: { userId: user.id, amount: a.value, method, msisdn: normalized, status: 'PROCESSANDO', idempotencyKey: idempotencyKey || null }
    });
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const prev = await prisma.depositRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prev) return { deposit: publicDeposit(prev), duplicate: true };
    }
    throw err;
  }

  try {
    const charge = await zumboPay.initiateCharge({ amount: a.value, msisdn: normalized, customerName: user.name, sourceId: `deposit-${deposit.id}` });
    const declined = charge.status === 'declined';
    deposit = await prisma.depositRequest.update({
      where: { id: deposit.id },
      data: { reference: charge.reference || null, status: declined ? 'FALHADA' : 'PROCESSANDO', rejectReason: charge.failReason || null }
    });
    if (declined) throw new WalletFlowError(charge.failReason || 'Pagamento recusado pelo operador.', 400, charge.failCode || 'GATEWAY_DECLINED', { retryable: charge.retryable !== false, fallback: 'MANUAL_DEPOSIT' });
    return { deposit: publicDeposit(deposit), duplicate: false };
  } catch (err) {
    if (err instanceof WalletFlowError) throw err;
    await prisma.depositRequest.updateMany({ where: { id: deposit.id, status: 'PROCESSANDO' }, data: { status: 'FALHADA', rejectReason: err.message } });
    throw new WalletFlowError(err.message || 'Não foi possível iniciar o carregamento. Tenta de novo.', 400, err.gatewayCode || 'BAD_REQUEST');
  }
};

const createManualDeposit = async (user, { amount, method, reference, proofUrl, idempotencyKey }) => {
  const limits = rules.getLimits();
  const a = rules.parseAmount(amount, { min: limits.minDeposit, max: limits.maxDeposit });
  if (!a.ok) throw new WalletFlowError(a.error);
  if (!['MPESA', 'EMOLA'].includes(method)) throw new WalletFlowError('Método inválido. Usa MPESA ou EMOLA.');
  const ref = rules.cleanText(reference, 80).toUpperCase();
  if (!ref && !proofUrl) throw new WalletFlowError('Indica o ID da transacção ou anexa o comprovativo.');
  if (proofUrl && !rules.isValidProofUrl(proofUrl)) throw new WalletFlowError('Link do comprovativo inválido.');

  if (idempotencyKey) {
    if (!rules.isValidIdempotencyKey(idempotencyKey)) throw new WalletFlowError('idempotencyKey inválida.');
    const prev = await prisma.depositRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
    if (prev) return { deposit: publicDeposit(prev), duplicate: true };
  }

  const pendingCount = await prisma.depositRequest.count({ where: { userId: user.id, status: 'PENDENTE', msisdn: null } });
  if (pendingCount >= MAX_PENDING_MANUAL_DEPOSITS) {
    throw new WalletFlowError('Tens demasiados depósitos à espera de aprovação. Aguarda a revisão.');
  }
  if (ref) {
    const reused = await prisma.depositRequest.findFirst({ where: { reference: ref, status: { not: 'REJEITADO' } }, select: { id: true } });
    if (reused) throw new WalletFlowError('Este ID de transacção já foi submetido.');
  }

  try {
    const deposit = await prisma.depositRequest.create({
      data: { userId: user.id, amount: a.value, method, reference: ref || null, proofUrl: proofUrl || null, status: 'PENDENTE', idempotencyKey: idempotencyKey || null }
    });
    return { deposit: publicDeposit(deposit), duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const prev = await prisma.depositRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prev) return { deposit: publicDeposit(prev), duplicate: true };
    }
    throw err;
  }
};

/** Credita um depósito (claim atómico + crédito na mesma transacção). */
const creditDeposit = async (depositId, { fromStatuses, adminId = null, description }) => {
  return prisma.$transaction(async (tx) => {
    const d = await tx.depositRequest.findUnique({ where: { id: depositId } });
    if (!d) return { credited: false, deposit: null };
    const claim = await tx.depositRequest.updateMany({
      where: { id: depositId, status: { in: fromStatuses } },
      data: { status: 'APROVADO', reviewedAt: new Date(), rejectReason: null, ...(adminId && { reviewedById: adminId }) }
    });
    if (claim.count === 0) return { credited: false, deposit: d };
    const moved = await walletService.credit(tx, {
      userId: d.userId, amount: d.amount, type: 'CREDITO_DEPOSITO',
      description, referenceType: 'DEPOSIT', referenceId: d.id
    });
    return { credited: true, deposit: d, balance: moved.wallet.balance };
  });
};

/** Chamado pelo webhook ZumboPay quando a referência pertence a um depósito. */
const handleDepositWebhook = async (deposit, type, event) => {
  if (type === 'payment.succeeded') {
    // Aceita também FALHADA: o utilizador pagou depois de o pedido ter expirado — o dinheiro é dele.
    const r = await creditDeposit(deposit.id, {
      fromStatuses: ['PROCESSANDO', 'FALHADA'],
      description: `Carregamento via ${deposit.method === 'MPESA' ? 'M-Pesa' : 'e-Mola'} — ref ${deposit.reference || deposit.id.slice(0, 8)}`
    });
    if (r.credited) {
      notifSvc.push(deposit.userId, {
        type: 'SUCCESS', title: 'Saldo carregado',
        message: `Recebemos ${fmt(deposit.amount)} MT na tua wallet. Novo saldo: ${fmt(r.balance)} MT.`, link: '/wallet'
      });
    }
    return r.credited;
  }
  if (type === 'payment.failed' && deposit.status === 'PROCESSANDO') {
    const cls = classifyGatewayError(event?.data?.message || 'Pagamento falhou.');
    const r = await prisma.depositRequest.updateMany({
      where: { id: deposit.id, status: 'PROCESSANDO' },
      data: { status: 'FALHADA', rejectReason: cls.message }
    });
    if (r.count) {
      logger.warn(`[wallet] depósito ${deposit.id} falhou (${cls.code}): ${cls.raw}`);
      notifSvc.push(deposit.userId, {
        type: 'ERROR', title: 'Carregamento falhou',
        message: cls.code === 'RESTRICTED_ACCOUNT'
          ? `O carregamento de ${fmt(deposit.amount)} MT foi recusado: a conta móvel deste número tem uma restrição da operadora. Usa outro número ou o depósito com comprovativo.`
          : `O carregamento de ${fmt(deposit.amount)} MT não foi concluído. ${cls.message}`,
        link: '/wallet'
      });
    }
  }
  return false;
};

const getMyDeposit = async (userId, id) => {
  let d = await prisma.depositRequest.findFirst({ where: { id, userId } });
  if (!d) throw new WalletFlowError('Depósito não encontrado.', 404, 'NOT_FOUND');
  d = await expireStaleStk(d);
  return publicDeposit(d);
};

const listMyDeposits = async (userId, { page = 1, limit = 20 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const pageN = Math.max(parseInt(page) || 1, 1);
  const [rows, total] = await Promise.all([
    prisma.depositRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, skip: (pageN - 1) * take }),
    prisma.depositRequest.count({ where: { userId } })
  ]);
  const fresh = await Promise.all(rows.map(expireStaleStk));
  return { items: fresh.map(publicDeposit), meta: { total, page: pageN, limit: take, pages: Math.ceil(total / take) } };
};

const cancelMyDeposit = async (userId, id) => {
  const d = await prisma.depositRequest.findFirst({ where: { id, userId } });
  if (!d) throw new WalletFlowError('Depósito não encontrado.', 404, 'NOT_FOUND');
  const stk = depositIsStk(d);
  const r = await prisma.depositRequest.updateMany({
    where: { id, userId, status: stk ? 'PROCESSANDO' : 'PENDENTE' },
    data: { status: stk ? 'FALHADA' : 'REJEITADO', rejectReason: 'Cancelado pelo utilizador.' }
  });
  if (r.count === 0) throw new WalletFlowError('Este depósito já não pode ser cancelado.');
};

// ─── Admin: depósitos manuais ────────────────────────────────────
const adminApproveDeposit = async (adminId, id) => {
  const d = await prisma.depositRequest.findUnique({ where: { id } });
  if (!d) throw new WalletFlowError('Depósito não encontrado.', 404, 'NOT_FOUND');
  if (depositIsStk(d)) throw new WalletFlowError('Depósitos automáticos são confirmados pelo operador, não manualmente.');
  if (d.userId === adminId) throw new WalletFlowError('Não podes aprovar o teu próprio depósito.', 403, 'FORBIDDEN');
  const r = await creditDeposit(id, {
    fromStatuses: ['PENDENTE'], adminId,
    description: `Depósito aprovado (${d.method === 'MPESA' ? 'M-Pesa' : 'e-Mola'}) — ref ${d.reference || d.id.slice(0, 8)}`
  });
  if (!r.credited) throw new WalletFlowError('Este depósito já foi tratado.', 409, 'CONFLICT');
  notifSvc.push(d.userId, {
    type: 'SUCCESS', title: 'Depósito aprovado',
    message: `${fmt(d.amount)} MT foram adicionados à tua wallet.`, link: '/wallet'
  });
  return { balance: r.balance, userId: d.userId, amount: d.amount };
};

const adminRejectDeposit = async (adminId, id, reason) => {
  const why = rules.cleanText(reason, 200);
  if (why.length < 3) throw new WalletFlowError('Indica o motivo da rejeição.');
  const d = await prisma.depositRequest.findUnique({ where: { id } });
  if (!d) throw new WalletFlowError('Depósito não encontrado.', 404, 'NOT_FOUND');
  const r = await prisma.depositRequest.updateMany({
    where: { id, status: 'PENDENTE', msisdn: null },
    data: { status: 'REJEITADO', rejectReason: why, reviewedById: adminId, reviewedAt: new Date() }
  });
  if (r.count === 0) throw new WalletFlowError('Este depósito já foi tratado.', 409, 'CONFLICT');
  notifSvc.push(d.userId, {
    type: 'ERROR', title: 'Depósito rejeitado',
    message: `O depósito de ${fmt(d.amount)} MT foi rejeitado: ${why}`, link: '/wallet'
  });
  return { userId: d.userId, amount: d.amount };
};

// ═════════════════════════════════════════════════════════════════
// Levantamentos
// ═════════════════════════════════════════════════════════════════
const publicWithdrawal = (w) => ({
  id: w.id, amount: w.amount, method: w.method, status: w.status,
  destination: rules.maskPhone(w.destination), rejectReason: w.rejectReason,
  createdAt: w.createdAt, reviewedAt: w.reviewedAt
});

const refundWithdrawal = async (tx, w, description) => {
  await tx.walletTransaction.updateMany({
    where: { referenceType: 'WITHDRAWAL', referenceId: w.id, type: 'DEBITO_LEVANTAMENTO' },
    data: { status: 'REVERTIDA' }
  });
  return walletService.credit(tx, {
    userId: w.userId, amount: w.amount, type: 'ESTORNO',
    description, referenceType: 'WITHDRAWAL_REFUND', referenceId: w.id
  });
};

const requestWithdrawal = async (user, { amount, destination, method, pin, idempotencyKey }) => {
  const limits = rules.getLimits();
  const a = rules.parseAmount(amount, { min: limits.minWithdraw, max: limits.maxWithdraw });
  if (!a.ok) throw new WalletFlowError(a.error);
  const normalized = zumboPay.normalizeMsisdn(destination);
  const detected = zumboPay.detectMethod(destination);
  if (!normalized || !detected) throw new WalletFlowError('Número de destino inválido. Usa um número M-Pesa (84/85) ou e-Mola (86/87).');
  if (method && method !== detected) throw new WalletFlowError(`O número indicado é ${detected === 'MPESA' ? 'M-Pesa' : 'e-Mola'}, não ${method === 'MPESA' ? 'M-Pesa' : 'e-Mola'}.`);

  if (idempotencyKey) {
    if (!rules.isValidIdempotencyKey(idempotencyKey)) throw new WalletFlowError('idempotencyKey inválida.');
    const prev = await prisma.withdrawalRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
    if (prev) return { withdrawal: publicWithdrawal(prev), duplicate: true };
  }

  await verifyPin(user.id, pin); // fora da transacção: tentativas falhadas persistem

  const wallet = await walletService.getOrCreateWallet(prisma, user.id);
  try {
    const withdrawal = await prisma.$transaction(async (tx) => {
      await lockWallet(tx, wallet.id);

      const pending = await tx.withdrawalRequest.count({ where: { userId: user.id, status: 'PENDENTE' } });
      if (pending >= MAX_PENDING_WITHDRAWALS) {
        throw new WalletFlowError(`Já tens ${pending} levantamentos à espera de pagamento. Aguarda que sejam processados.`);
      }
      const today = await sumToday(tx, wallet.id, 'DEBITO_LEVANTAMENTO');
      if (today + a.value > limits.dailyWithdraw + 1e-9) {
        throw new WalletFlowError(`Limite diário de levantamentos excedido. Ainda podes levantar ${fmt(Math.max(0, limits.dailyWithdraw - today))} MT hoje.`, 400, 'DAILY_LIMIT');
      }

      const w = await tx.withdrawalRequest.create({
        data: { userId: user.id, amount: a.value, method: detected, destination: normalized, status: 'PENDENTE', idempotencyKey: idempotencyKey || null }
      });
      await walletService.debit(tx, {
        userId: user.id, amount: a.value, type: 'DEBITO_LEVANTAMENTO', status: 'PENDENTE',
        description: `Levantamento para ${detected === 'MPESA' ? 'M-Pesa' : 'e-Mola'} ${rules.maskPhone(normalized)}`,
        referenceType: 'WITHDRAWAL', referenceId: w.id
      });
      return w;
    });
    return { withdrawal: publicWithdrawal(withdrawal), duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const prev = await prisma.withdrawalRequest.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prev) return { withdrawal: publicWithdrawal(prev), duplicate: true };
    }
    throw err;
  }
};

const listMyWithdrawals = async (userId, { page = 1, limit = 20 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const pageN = Math.max(parseInt(page) || 1, 1);
  const [rows, total] = await Promise.all([
    prisma.withdrawalRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, skip: (pageN - 1) * take }),
    prisma.withdrawalRequest.count({ where: { userId } })
  ]);
  return { items: rows.map(publicWithdrawal), meta: { total, page: pageN, limit: take, pages: Math.ceil(total / take) } };
};

const cancelMyWithdrawal = async (userId, id) => {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawalRequest.findFirst({ where: { id, userId } });
    if (!w) throw new WalletFlowError('Levantamento não encontrado.', 404, 'NOT_FOUND');
    const claim = await tx.withdrawalRequest.updateMany({ where: { id, userId, status: 'PENDENTE' }, data: { status: 'CANCELADO', reviewedAt: new Date() } });
    if (claim.count === 0) throw new WalletFlowError('Este levantamento já foi processado e não pode ser cancelado.');
    const moved = await refundWithdrawal(tx, w, 'Levantamento cancelado — valor devolvido');
    return { balance: moved.wallet.balance };
  });
};

const adminPayWithdrawal = async (adminId, id, notes) => {
  const w = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!w) throw new WalletFlowError('Levantamento não encontrado.', 404, 'NOT_FOUND');
  if (w.userId === adminId) throw new WalletFlowError('Não podes processar o teu próprio levantamento.', 403, 'FORBIDDEN');
  await prisma.$transaction(async (tx) => {
    const claim = await tx.withdrawalRequest.updateMany({
      where: { id, status: 'PENDENTE' },
      data: { status: 'PAGO', reviewedById: adminId, reviewedAt: new Date(), notes: rules.cleanText(notes, 300) || null }
    });
    if (claim.count === 0) throw new WalletFlowError('Este levantamento já foi tratado.', 409, 'CONFLICT');
    await tx.walletTransaction.updateMany({
      where: { referenceType: 'WITHDRAWAL', referenceId: id, type: 'DEBITO_LEVANTAMENTO' },
      data: { status: 'CONCLUIDA' }
    });
  });
  notifSvc.push(w.userId, {
    type: 'SUCCESS', title: 'Levantamento pago',
    message: `${fmt(w.amount)} MT foram enviados para ${rules.maskPhone(w.destination)}.`, link: '/wallet'
  });
  return { userId: w.userId, amount: w.amount };
};

const adminRejectWithdrawal = async (adminId, id, reason) => {
  const why = rules.cleanText(reason, 200);
  if (why.length < 3) throw new WalletFlowError('Indica o motivo da rejeição.');
  const result = await prisma.$transaction(async (tx) => {
    const w = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!w) throw new WalletFlowError('Levantamento não encontrado.', 404, 'NOT_FOUND');
    const claim = await tx.withdrawalRequest.updateMany({
      where: { id, status: 'PENDENTE' },
      data: { status: 'REJEITADO', rejectReason: why, reviewedById: adminId, reviewedAt: new Date() }
    });
    if (claim.count === 0) throw new WalletFlowError('Este levantamento já foi tratado.', 409, 'CONFLICT');
    const moved = await refundWithdrawal(tx, w, `Levantamento rejeitado — valor devolvido (${why})`);
    return { w, balance: moved.wallet.balance };
  });
  notifSvc.push(result.w.userId, {
    type: 'ERROR', title: 'Levantamento rejeitado',
    message: `O levantamento de ${fmt(result.w.amount)} MT foi rejeitado e o valor devolvido à wallet. Motivo: ${why}`, link: '/wallet'
  });
  return { userId: result.w.userId, amount: result.w.amount };
};

// ═════════════════════════════════════════════════════════════════
// Transferências P2P
// ═════════════════════════════════════════════════════════════════
const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username || null, avatarUrl: u.avatarUrl || null, verifiedSeller: Boolean(u.verifiedSeller) });

const loadRecipient = async (senderId, recipientId) => {
  if (!recipientId || recipientId === senderId) throw new WalletFlowError('Não podes enviar dinheiro para ti próprio.');
  const r = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true, active: true, isBazarBot: true }
  });
  if (!r || !r.active || r.isBazarBot) throw new WalletFlowError('Destinatário não encontrado.', 404, 'NOT_FOUND');
  if (await blockService.isBlockedEither(senderId, recipientId)) {
    throw new WalletFlowError('Não é possível enviar dinheiro para este utilizador.', 403, 'FORBIDDEN');
  }
  return r;
};

/** Procura destinatários por @username, email exacto ou telefone. Devolve poucos resultados, sem dados sensíveis. */
const searchRecipients = async (userId, rawQuery) => {
  const q = rules.cleanText(rawQuery, 80);
  if (q.length < 3) return [];
  const base = { id: { not: userId }, active: true, isBazarBot: false };
  const or = [];
  const handle = q.replace(/^@/, '').toLowerCase();
  if (/^[a-z0-9._]{3,30}$/.test(handle)) or.push({ username: { startsWith: handle, mode: 'insensitive' } });
  if (q.includes('@') && !q.startsWith('@') && q.length <= 80) or.push({ email: q.toLowerCase() });
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 9) or.push({ phone: { endsWith: digits.slice(-9) } });
  if (!or.length) return [];

  const users = await prisma.user.findMany({
    where: { ...base, OR: or },
    select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true, phone: true },
    take: 6
  });
  if (!users.length) return [];
  const blocked = new Set(await blockService.blockedAmong(userId, users.map((u) => u.id)));
  return users.filter((u) => !blocked.has(u.id)).slice(0, 5).map((u) => ({ ...publicUser(u), phoneMasked: rules.maskPhone(u.phone) }));
};

const recentRecipients = async (userId, limit = 8) => {
  const wallet = await walletService.getOrCreateWallet(prisma, userId);
  const sent = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id, type: 'TRANSFERENCIA_ENVIADA', referenceType: { in: ['TRANSFER', 'MONEY_REQUEST'] }, status: 'CONCLUIDA' },
    orderBy: { createdAt: 'desc' }, take: 40, select: { referenceType: true, referenceId: true }
  });
  const refs = [...new Set(sent.map((s) => s.referenceId).filter(Boolean))];
  if (!refs.length) return [];
  const received = await prisma.walletTransaction.findMany({
    where: { type: 'TRANSFERENCIA_RECEBIDA', referenceId: { in: refs }, walletId: { not: wallet.id } },
    orderBy: { createdAt: 'desc' },
    include: { wallet: { select: { user: { select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true, active: true } } } } }
  });
  const seen = new Set();
  const out = [];
  for (const r of received) {
    const u = r.wallet?.user;
    if (!u || !u.active || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(publicUser(u));
    if (out.length >= limit) break;
  }
  return out;
};

/** Move dinheiro A→B numa transacção com limite diário e idempotência. Reutilizado por transfer e money-request. */
const moveP2P = async (tx, { sender, recipient, amount, note, referenceType, referenceId }) => {
  const limits = rules.getLimits();
  const wallet = await walletService.getOrCreateWallet(tx, sender.id);
  await lockWallet(tx, wallet.id);

  const prev = await tx.walletTransaction.findFirst({
    where: { walletId: wallet.id, type: 'TRANSFERENCIA_ENVIADA', referenceType, referenceId }
  });
  if (prev) return { duplicate: true, balance: prev.balanceAfter };

  const today = await sumToday(tx, wallet.id, 'TRANSFERENCIA_ENVIADA');
  if (today + amount > limits.dailyTransfer + 1e-9) {
    throw new WalletFlowError(`Limite diário de transferências excedido. Ainda podes enviar ${fmt(Math.max(0, limits.dailyTransfer - today))} MT hoje.`, 400, 'DAILY_LIMIT');
  }
  const suffix = note ? ` — ${note}` : '';
  const debited = await walletService.debit(tx, {
    userId: sender.id, amount, type: 'TRANSFERENCIA_ENVIADA',
    description: `Enviado para ${recipient.name}${suffix}`.slice(0, 250), referenceType, referenceId
  });
  await walletService.credit(tx, {
    userId: recipient.id, amount, type: 'TRANSFERENCIA_RECEBIDA',
    description: `Recebido de ${sender.name}${suffix}`.slice(0, 250), referenceType, referenceId
  });
  return { duplicate: false, balance: debited.wallet.balance };
};

const transferP2P = async (sender, { toUserId, amount, note, pin, idempotencyKey }) => {
  const limits = rules.getLimits();
  const a = rules.parseAmount(amount, { min: limits.minTransfer, max: limits.maxTransfer });
  if (!a.ok) throw new WalletFlowError(a.error);
  if (idempotencyKey && !rules.isValidIdempotencyKey(idempotencyKey)) throw new WalletFlowError('idempotencyKey inválida.');
  const recipient = await loadRecipient(sender.id, toUserId);
  await verifyPin(sender.id, pin);

  const key = idempotencyKey || crypto.randomUUID();
  const cleanNote = rules.cleanText(note, 80);
  const result = await prisma.$transaction((tx) => moveP2P(tx, { sender, recipient, amount: a.value, note: cleanNote, referenceType: 'TRANSFER', referenceId: key }));

  if (!result.duplicate) {
    notifSvc.push(recipient.id, {
      type: 'SUCCESS', title: 'Recebeste dinheiro',
      message: `${sender.name} enviou-te ${fmt(a.value)} MT${cleanNote ? ` — "${cleanNote}"` : ''}.`, link: '/wallet'
    });
  }
  return { balance: result.balance, duplicate: result.duplicate, recipient: publicUser(recipient), amount: a.value, reference: key };
};

// ═════════════════════════════════════════════════════════════════
// Pedidos de dinheiro
// ═════════════════════════════════════════════════════════════════
const expireMoneyRequests = (userId) =>
  prisma.moneyRequest.updateMany({
    where: { status: 'PENDENTE', expiresAt: { lte: new Date() }, OR: [{ requesterId: userId }, { payerId: userId }] },
    data: { status: 'EXPIRADO', respondedAt: new Date() }
  });

const publicMoneyRequest = (r) => ({
  id: r.id, amount: r.amount, note: r.note, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, respondedAt: r.respondedAt,
  requester: r.requester ? publicUser(r.requester) : undefined,
  payer: r.payer ? publicUser(r.payer) : undefined
});

const createMoneyRequest = async (requester, { payerId, amount, note }) => {
  const limits = rules.getLimits();
  const a = rules.parseAmount(amount, { min: limits.minTransfer, max: limits.maxTransfer });
  if (!a.ok) throw new WalletFlowError(a.error);
  const payer = await loadRecipient(requester.id, payerId);
  const pending = await prisma.moneyRequest.count({ where: { requesterId: requester.id, status: 'PENDENTE', expiresAt: { gt: new Date() } } });
  if (pending >= MAX_PENDING_MONEY_REQUESTS) throw new WalletFlowError('Tens demasiados pedidos pendentes. Aguarda que respondam ou cancela alguns.');
  const cleanNote = rules.cleanText(note, 80);
  const req = await prisma.moneyRequest.create({
    data: { requesterId: requester.id, payerId: payer.id, amount: a.value, note: cleanNote || null, expiresAt: new Date(Date.now() + limits.moneyRequestTtlHours * 3600 * 1000) },
    include: { requester: { select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true } }, payer: { select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true } } }
  });
  notifSvc.push(payer.id, {
    type: 'INFO', title: 'Pedido de dinheiro',
    message: `${requester.name} pediu-te ${fmt(a.value)} MT${cleanNote ? ` — "${cleanNote}"` : ''}.`, link: '/wallet'
  });
  return publicMoneyRequest(req);
};

const listMoneyRequests = async (userId, { box = 'received', page = 1, limit = 20 } = {}) => {
  await expireMoneyRequests(userId);
  const take = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const pageN = Math.max(parseInt(page) || 1, 1);
  const where = box === 'sent' ? { requesterId: userId } : { payerId: userId };
  const [rows, total] = await Promise.all([
    prisma.moneyRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take, skip: (pageN - 1) * take,
      include: { requester: { select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true } }, payer: { select: { id: true, name: true, username: true, avatarUrl: true, verifiedSeller: true } } }
    }),
    prisma.moneyRequest.count({ where })
  ]);
  return { items: rows.map(publicMoneyRequest), meta: { total, page: pageN, limit: take, pages: Math.ceil(total / take) } };
};

const payMoneyRequest = async (payer, id, pin) => {
  await expireMoneyRequests(payer.id);
  const req = await prisma.moneyRequest.findFirst({ where: { id, payerId: payer.id } });
  if (!req) throw new WalletFlowError('Pedido não encontrado.', 404, 'NOT_FOUND');
  if (req.status !== 'PENDENTE') throw new WalletFlowError('Este pedido já não está pendente.');
  const requester = await loadRecipient(payer.id, req.requesterId);
  await verifyPin(payer.id, pin);

  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.moneyRequest.updateMany({
      where: { id, payerId: payer.id, status: 'PENDENTE', expiresAt: { gt: new Date() } },
      data: { status: 'PAGO', respondedAt: new Date() }
    });
    if (claim.count === 0) throw new WalletFlowError('Este pedido já foi tratado ou expirou.', 409, 'CONFLICT');
    return moveP2P(tx, { sender: payer, recipient: requester, amount: req.amount, note: rules.cleanText(req.note, 80), referenceType: 'MONEY_REQUEST', referenceId: id });
  });
  notifSvc.push(requester.id, {
    type: 'SUCCESS', title: 'Pedido pago',
    message: `${payer.name} pagou os ${fmt(req.amount)} MT que pediste.`, link: '/wallet'
  });
  return { balance: result.balance, amount: req.amount };
};

const closeMoneyRequest = async (userId, id, mode) => {
  const isDecline = mode === 'decline';
  const req = await prisma.moneyRequest.findFirst({ where: isDecline ? { id, payerId: userId } : { id, requesterId: userId } });
  if (!req) throw new WalletFlowError('Pedido não encontrado.', 404, 'NOT_FOUND');
  const r = await prisma.moneyRequest.updateMany({
    where: { id, status: 'PENDENTE' },
    data: { status: isDecline ? 'RECUSADO' : 'CANCELADO', respondedAt: new Date() }
  });
  if (r.count === 0) throw new WalletFlowError('Este pedido já não está pendente.');
  const other = isDecline ? req.requesterId : req.payerId;
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  notifSvc.push(other, {
    type: 'INFO', title: isDecline ? 'Pedido recusado' : 'Pedido cancelado',
    message: isDecline ? `${me?.name || 'O utilizador'} recusou o teu pedido de ${fmt(req.amount)} MT.` : `${me?.name || 'O utilizador'} cancelou o pedido de ${fmt(req.amount)} MT.`,
    link: '/wallet'
  });
};

// ═════════════════════════════════════════════════════════════════
// Admin: listas e visão geral
// ═════════════════════════════════════════════════════════════════
const adminList = async (model, { status, page = 1, limit = 30 }) => {
  const take = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
  const pageN = Math.max(parseInt(page) || 1, 1);
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma[model].findMany({
      where, orderBy: { createdAt: 'desc' }, take, skip: (pageN - 1) * take,
      include: { user: { select: { id: true, name: true, email: true, phone: true } } }
    }),
    prisma[model].count({ where })
  ]);
  return { items, meta: { total, page: pageN, limit: take, pages: Math.ceil(total / take) } };
};

const adminOverview = async () => {
  const [wallets, pendingDeps, pendingWith, held] = await Promise.all([
    prisma.wallet.aggregate({ _sum: { balance: true }, _count: true }),
    prisma.depositRequest.aggregate({ where: { status: { in: ['PENDENTE', 'PROCESSANDO'] } }, _sum: { amount: true }, _count: true }),
    prisma.withdrawalRequest.aggregate({ where: { status: 'PENDENTE' }, _sum: { amount: true }, _count: true }),
    prisma.walletTransaction.aggregate({ where: { status: 'PENDENTE', type: 'DEBITO_LEVANTAMENTO' }, _sum: { amount: true } })
  ]);
  return {
    wallets: wallets._count,
    totalBalance: wallets._sum.balance || 0,
    pendingDeposits: { count: pendingDeps._count, amount: pendingDeps._sum.amount || 0 },
    pendingWithdrawals: { count: pendingWith._count, amount: pendingWith._sum.amount || 0 },
    heldInWithdrawals: held._sum.amount || 0
  };
};

module.exports = {
  WalletFlowError,
  // PIN
  hasPin, verifyPin, setOrChangePin, resetPinWithPassword, adminClearPin,
  // resumo / extracto
  getSummary, getStatementFiltered, exportStatementCsv, getReceipt,
  // depósitos
  createStkDeposit, createManualDeposit, handleDepositWebhook, getMyDeposit, listMyDeposits, cancelMyDeposit,
  adminApproveDeposit, adminRejectDeposit,
  // levantamentos
  requestWithdrawal, listMyWithdrawals, cancelMyWithdrawal, adminPayWithdrawal, adminRejectWithdrawal,
  // transferências / pedidos
  searchRecipients, recentRecipients, transferP2P,
  createMoneyRequest, listMoneyRequests, payMoneyRequest, closeMoneyRequest,
  // admin
  adminList, adminOverview
};
