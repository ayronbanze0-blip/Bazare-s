'use strict';

/**
 * Pagamento com a carteira e em parcelas.
 *
 * Fluxo de dinheiro (tudo dentro de transacções Prisma, saldo SEMPRE movido via walletService):
 *   - checkout CARTEIRA : debita o comprador e credita o vendedor pelo total (plano de 1 prestação, já paga)
 *   - checkout PARCELAS : debita a ENTRADA no checkout; as parcelas seguintes são pagas pelo comprador
 *                         (com PIN) ou debitadas automaticamente na data (autoPay) — tolerância + multa única
 *   - encomenda cancelada: parcelas por pagar são canceladas e o que já foi pago é reembolsado ao comprador
 *                         (debitado ao vendedor; se o vendedor não tiver saldo fica "reembolso pendente")
 *
 * Idempotência: cada movimento tem referenceId único (id da parcela / do reembolso) e as mudanças de estado
 * usam `updateMany` condicional ("claim") — dois pedidos concorrentes nunca pagam/reembolsam duas vezes.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const walletService = require('./walletService');
const notifSvc = require('./notificationService');
const rules = require('./installmentRules');
const { AppError, bad, notFoundErr, forbiddenErr, conflictErr } = require('../utils/appError');
const { round2 } = require('../utils/validate');

const fmt = (n) => Number(n).toLocaleString('pt-MZ');
const short = (id) => String(id).slice(-8);
const orderLink = (orderId) => `order-detail.html?id=${orderId}`;
const OPEN = ['PENDENTE', 'ATRASADA'];

const lockWallet = (tx, walletId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + walletId}))`;

// ─────────────────────────────────────────────────────────────────
// Movimento de dinheiro comprador ⇄ vendedor (idempotente)
// ─────────────────────────────────────────────────────────────────
/**
 * Debita `fromUserId` e credita `toUserId` na MESMA transacção. Se já existir um movimento de débito com o mesmo
 * (type, referenceType, referenceId) na carteira de origem, não repete nada (duplicate:true).
 */
async function movePayment(tx, { fromUserId, toUserId, amount, description, debitType, creditType, referenceType, referenceId }) {
  const value = round2(amount);
  if (!(value > 0)) throw bad('Valor inválido.', 'AMOUNT_INVALID');
  const fromWallet = await walletService.getOrCreateWallet(tx, fromUserId);
  await lockWallet(tx, fromWallet.id);

  const prev = await tx.walletTransaction.findFirst({
    where: { walletId: fromWallet.id, type: debitType, referenceType, referenceId }
  });
  if (prev) return { duplicate: true, balance: prev.balanceAfter };

  const debited = await walletService.debit(tx, { userId: fromUserId, amount: value, type: debitType, description: String(description).slice(0, 250), referenceType, referenceId });
  await walletService.credit(tx, { userId: toUserId, amount: value, type: creditType, description: String(description).slice(0, 250), referenceType, referenceId });
  return { duplicate: false, balance: debited.wallet.balance };
}

// ─────────────────────────────────────────────────────────────────
// Definições do vendedor
// ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTING = Object.freeze({ enabled: false, maxInstallments: 3, minOrderAmount: 500, downPaymentPct: 30, interestPct: 0, frequencyDays: 30 });

const getSettings = async (sellerId, client = prisma) => {
  const row = await client.installmentSetting.findUnique({ where: { sellerId } });
  return row || { sellerId, ...DEFAULT_SETTING };
};

const saveSettings = async (sellerId, input) => {
  const data = rules.parseSettingsInput(input);
  return prisma.installmentSetting.upsert({ where: { sellerId }, create: { sellerId, ...data }, update: data });
};

/** Condições públicas de parcelas de vários vendedores (para o checkout mostrar quem aceita). */
const publicSettingsFor = async (sellerIds, client = prisma) => {
  const rows = await client.installmentSetting.findMany({ where: { sellerId: { in: sellerIds }, enabled: true } });
  return new Map(rows.map((r) => [r.sellerId, r]));
};

// ─────────────────────────────────────────────────────────────────
// Elegibilidade do comprador
// ─────────────────────────────────────────────────────────────────
async function assertBuyerEligible(buyerId, client = prisma) {
  const [defaulted, active] = await Promise.all([
    client.installmentPlan.count({ where: { buyerId, status: 'DEFAULTED' } }),
    client.installmentPlan.count({ where: { buyerId, status: 'ACTIVE', mode: 'PARCELAS' } })
  ]);
  if (defaulted > 0) throw new AppError('Tens parcelas em atraso. Regulariza-as para voltar a comprar em parcelas.', 403, 'INSTALLMENTS_BLOCKED');
  if (active >= rules.maxActivePlans()) throw new AppError(`Já tens ${active} compras em parcelas a decorrer (máximo ${rules.maxActivePlans()}).`, 403, 'INSTALLMENTS_LIMIT');
}

// ─────────────────────────────────────────────────────────────────
// Criação do plano (dentro da transacção da encomenda)
// ─────────────────────────────────────────────────────────────────
/**
 * @param tx    cliente da transacção
 * @param p.order     encomenda já criada (id, total, buyerId, sellerId)
 * @param p.mode      'CARTEIRA' | 'PARCELAS'
 * @param p.schedule  resultado de rules.buildSchedule (só PARCELAS)
 * @param p.setting   definições do vendedor (só PARCELAS)
 */
async function createPlanTx(tx, { order, buyerName, mode, count = 0, schedule = null, setting = null, autoPay = true, now = new Date() }) {
  const isWallet = mode === 'CARTEIRA';
  const downNow = isWallet ? round2(order.total) : schedule.down;
  const totalPayable = isWallet ? round2(order.total) : schedule.totalPayable;

  const plan = await tx.installmentPlan.create({
    data: {
      orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, mode,
      count: isWallet ? 0 : count,
      frequencyDays: isWallet ? 30 : setting.frequencyDays,
      interestPct: isWallet ? 0 : setting.interestPct,
      principal: round2(order.total), totalAmount: totalPayable,
      paidAmount: downNow, autoPay: Boolean(autoPay),
      status: isWallet ? 'COMPLETED' : 'ACTIVE'
    }
  });

  const entrada = await tx.installment.create({
    data: { planId: plan.id, number: 0, amount: downNow, dueDate: now, status: 'PAGA', paidAt: now }
  });
  if (!isWallet) {
    await tx.installment.createMany({
      data: schedule.parcels.map((p) => ({ planId: plan.id, number: p.number, amount: p.amount, dueDate: p.dueDate, status: 'PENDENTE' }))
    });
  }

  await movePayment(tx, {
    fromUserId: order.buyerId, toUserId: order.sellerId, amount: downNow,
    description: isWallet ? `Pagamento da encomenda #${short(order.id)}` : `Entrada da encomenda #${short(order.id)} (parcelada em ${count}x)`,
    debitType: 'PAGAMENTO_COMPRA', creditType: 'RECEBIMENTO_VENDA',
    referenceType: 'INSTALLMENT', referenceId: entrada.id
  });
  return plan;
}

// ─────────────────────────────────────────────────────────────────
// Pagar parcelas
// ─────────────────────────────────────────────────────────────────
const payable = (inst) => round2(Number(inst.amount) + Number(inst.lateFee || 0));

/**
 * Liquida uma ou mais parcelas do MESMO plano numa única transacção (tudo ou nada).
 * `actor`: 'buyer' (com PIN, já verificado pelo chamador) | 'autopay'.
 */
async function settleInstallments(planId, installmentIds, { actor = 'buyer', now = new Date() } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    const plan = await tx.installmentPlan.findUnique({ where: { id: planId } });
    if (!plan) throw notFoundErr('Plano não encontrado.');
    if (!['ACTIVE', 'DEFAULTED'].includes(plan.status)) throw conflictErr('Este plano já não aceita pagamentos.', 'PLAN_CLOSED');

    const insts = await tx.installment.findMany({ where: { planId, id: { in: installmentIds } }, orderBy: { number: 'asc' } });
    if (insts.length !== installmentIds.length) throw notFoundErr('Parcela não encontrada.');

    let paidNow = 0;
    const settled = [];
    for (const inst of insts) {
      const claim = await tx.installment.updateMany({ where: { id: inst.id, status: { in: OPEN } }, data: { status: 'PAGA', paidAt: now } });
      if (claim.count === 0) throw conflictErr('Esta parcela já foi paga.', 'INSTALLMENT_ALREADY_PAID');
      const amount = payable(inst);
      const label = inst.number === 0 ? 'Entrada' : `Parcela ${inst.number}/${plan.count}`;
      await movePayment(tx, {
        fromUserId: plan.buyerId, toUserId: plan.sellerId, amount,
        description: `${label} da encomenda #${short(plan.orderId)}${actor === 'autopay' ? ' (débito automático)' : ''}`,
        debitType: 'PAGAMENTO_COMPRA', creditType: 'RECEBIMENTO_VENDA',
        referenceType: 'INSTALLMENT', referenceId: inst.id
      });
      paidNow = round2(paidNow + amount);
      settled.push({ id: inst.id, number: inst.number, amount });
    }

    const all = await tx.installment.findMany({ where: { planId }, select: { status: true, dueDate: true } });
    const status = rules.derivePlanStatus(all, now);
    await tx.installmentPlan.update({ where: { id: planId }, data: { paidAmount: { increment: paidNow }, status } });
    return { plan, settled, paidNow, status };
  }, { timeout: 20000 });

  // Notificações fora da transacção
  const { plan, settled, paidNow, status } = result;
  const parcelsTxt = settled.map((s) => (s.number === 0 ? 'entrada' : `parcela ${s.number}`)).join(', ');
  notifSvc.push(plan.sellerId, { type: 'SUCCESS', category: 'orders', title: 'Pagamento recebido', message: `Recebeste ${fmt(paidNow)} MT (${parcelsTxt}) da encomenda #${short(plan.orderId)}.`, link: orderLink(plan.orderId) });
  notifSvc.push(plan.buyerId, { type: 'SUCCESS', category: 'orders', title: status === 'COMPLETED' ? 'Compra totalmente paga 🎉' : 'Pagamento efectuado', message: status === 'COMPLETED' ? `Pagaste a última parcela da encomenda #${short(plan.orderId)}.` : `Pagaste ${fmt(paidNow)} MT (${parcelsTxt}) da encomenda #${short(plan.orderId)}.`, link: orderLink(plan.orderId) });
  return { paid: paidNow, settled, planStatus: status };
}

/** Parcela(s) que o comprador pode pagar agora: respeita a ordem (não se salta parcelas). */
async function resolvePayTargets(userId, { planId, installmentId, all = false }) {
  // Sem isto, `planId: undefined` seria ignorado pelo Prisma e o filtro apanhava TODAS as parcelas do comprador.
  if (!planId && !installmentId) throw bad('Indica o plano ou a parcela a pagar.', 'VALIDATION_ERROR');
  const where = installmentId ? { id: installmentId } : { planId };
  const insts = await prisma.installment.findMany({ where: { ...where, plan: { buyerId: userId } }, orderBy: { number: 'asc' }, include: { plan: true } });
  if (insts.length === 0) throw notFoundErr('Parcela não encontrada.');
  const plan = insts[0].plan;
  const open = await prisma.installment.findMany({ where: { planId: plan.id, status: { in: OPEN } }, orderBy: { number: 'asc' } });
  if (open.length === 0) throw conflictErr('Não há parcelas por pagar neste plano.', 'NOTHING_TO_PAY');

  if (all) return { plan, ids: open.map((i) => i.id) };
  const target = installmentId ? open.find((i) => i.id === installmentId) : open[0];
  if (!target) throw conflictErr('Esta parcela já foi paga.', 'INSTALLMENT_ALREADY_PAID');
  if (open[0].id !== target.id) throw conflictErr(`Paga primeiro a parcela ${open[0].number}.`, 'PAY_IN_ORDER', { nextNumber: open[0].number });
  return { plan, ids: [target.id] };
}

// ─────────────────────────────────────────────────────────────────
// Cancelamento e reembolso
// ─────────────────────────────────────────────────────────────────
/** Dentro da transacção de cancelamento da encomenda. Devolve o valor a reembolsar (0 se não há plano). */
async function cancelPlanTx(tx, orderId) {
  const plan = await tx.installmentPlan.findUnique({ where: { orderId } });
  if (!plan || plan.status === 'CANCELLED') return { planId: null, refundable: 0 };
  await tx.installment.updateMany({ where: { planId: plan.id, status: { in: OPEN } }, data: { status: 'CANCELADA' } });
  const refundable = round2(Number(plan.paidAmount) - Number(plan.refundedAmount) - Number(plan.refundPendingAmount));
  await tx.installmentPlan.update({
    where: { id: plan.id },
    data: { status: 'CANCELLED', ...(refundable > 0 && { refundPendingAmount: { increment: refundable } }) }
  });
  return { planId: plan.id, refundable: Math.max(0, refundable) };
}

/**
 * Tenta devolver ao comprador o que está em `refundPendingAmount`. Idempotente e seguro para repetir.
 * Se o vendedor não tiver saldo, o valor FICA pendente (e vendedor + admins são avisados).
 */
async function refundPlan(planId, { reason = 'Encomenda cancelada' } = {}) {
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan) return { refunded: 0, pending: 0 };
  const amount = round2(plan.refundPendingAmount);
  if (!(amount > 0)) return { refunded: 0, pending: 0 };

  try {
    const out = await prisma.$transaction(async (tx) => {
      const claim = await tx.installmentPlan.updateMany({
        where: { id: plan.id, refundPendingAmount: plan.refundPendingAmount },
        data: { refundPendingAmount: 0, refundedAmount: { increment: amount } }
      });
      if (claim.count === 0) return { refunded: 0, pending: 0, raced: true };
      await movePayment(tx, {
        fromUserId: plan.sellerId, toUserId: plan.buyerId, amount,
        description: `Reembolso da encomenda #${short(plan.orderId)} — ${reason}`,
        debitType: 'REEMBOLSO_VENDA', creditType: 'REEMBOLSO_COMPRA',
        referenceType: 'INSTALLMENT_REFUND', referenceId: `${plan.id}:${Math.round(Number(plan.refundedAmount) * 100)}`
      });
      return { refunded: amount, pending: 0 };
    }, { timeout: 15000 });

    if (out.refunded > 0) {
      notifSvc.push(plan.buyerId, { type: 'SUCCESS', category: 'orders', title: 'Reembolso recebido', message: `${fmt(out.refunded)} MT foram devolvidos à tua carteira (encomenda #${short(plan.orderId)}).`, link: '/wallet' });
    }
    return out;
  } catch (err) {
    if (err && err.name === 'InsufficientFundsError') {
      notifSvc.push(plan.sellerId, { type: 'WARNING', category: 'system', title: 'Reembolso pendente', message: `Tens de devolver ${fmt(amount)} MT ao comprador (encomenda #${short(plan.orderId)}). Carrega a carteira — o reembolso é feito assim que houver saldo.`, link: '/wallet' });
      notifSvc.push(plan.buyerId, { type: 'INFO', category: 'orders', title: 'Reembolso a caminho', message: `O reembolso de ${fmt(amount)} MT da encomenda #${short(plan.orderId)} está pendente do vendedor.`, link: orderLink(plan.orderId) });
      logger.warn(`[Installments] reembolso pendente: plano ${plan.id}, ${amount} MT (vendedor sem saldo)`);
      return { refunded: 0, pending: amount };
    }
    logger.error(`[Installments.refundPlan] ${err && err.message}`);
    return { refunded: 0, pending: amount, error: true };
  }
}

/** Reembolso parcial (ex.: disputa resolvida a favor do comprador). Limitado ao que foi realmente pago. */
async function requestRefund(planId, amount, { reason }) {
  const value = round2(amount);
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan) return { refunded: 0, pending: 0, noPlan: true };
  const available = round2(Number(plan.paidAmount) - Number(plan.refundedAmount) - Number(plan.refundPendingAmount));
  const toRefund = Math.min(value, Math.max(0, available));
  if (!(toRefund > 0)) return { refunded: 0, pending: 0 };
  await prisma.installmentPlan.update({ where: { id: planId }, data: { refundPendingAmount: { increment: toRefund } } });
  return refundPlan(planId, { reason });
}

// ─────────────────────────────────────────────────────────────────
// Job periódico: avisos, débito automático, multas, incumprimento
// ─────────────────────────────────────────────────────────────────
async function runInstallmentJob({ now = new Date() } = {}) {
  const stats = { reminded: 0, autoPaid: 0, autoPayFailed: 0, overdue: 0, defaulted: 0 };
  const HOUR = 3600000;

  // 1) Lembretes (X dias antes do vencimento) — uma vez por parcela
  const reminderUntil = new Date(now.getTime() + rules.reminderDaysBefore() * 24 * HOUR);
  const toRemind = await prisma.installment.findMany({
    where: { status: 'PENDENTE', number: { gt: 0 }, dueDate: { gt: now, lte: reminderUntil }, reminderSentAt: null, plan: { status: 'ACTIVE' } },
    include: { plan: { select: { buyerId: true, orderId: true, count: true, autoPay: true } } }, take: 500
  });
  for (const inst of toRemind) {
    const claim = await prisma.installment.updateMany({ where: { id: inst.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claim.count === 0) continue;
    const when = new Date(inst.dueDate).toLocaleDateString('pt-MZ');
    notifSvc.push(inst.plan.buyerId, {
      type: 'INFO', category: 'orders', title: 'Parcela a vencer',
      message: `A parcela ${inst.number}/${inst.plan.count} (${fmt(inst.amount)} MT) da encomenda #${short(inst.plan.orderId)} vence a ${when}.${inst.plan.autoPay ? ' Garante saldo na carteira para o débito automático.' : ''}`,
      link: orderLink(inst.plan.orderId)
    });
    stats.reminded++;
  }

  // 2) Débito automático (a partir do vencimento; repete de X em X horas)
  const retryBefore = new Date(now.getTime() - rules.autoPayRetryHours() * HOUR);
  const dueForAutoPay = await prisma.installment.findMany({
    where: {
      status: { in: OPEN }, number: { gt: 0 }, dueDate: { lte: now },
      plan: { autoPay: true, status: { in: ['ACTIVE', 'DEFAULTED'] } },
      OR: [{ lastAutoPayAttemptAt: null }, { lastAutoPayAttemptAt: { lt: retryBefore } }]
    },
    orderBy: [{ planId: 'asc' }, { number: 'asc' }], include: { plan: { select: { id: true, buyerId: true, orderId: true } } }, take: 300
  });
  const blockedPlans = new Set();
  for (const inst of dueForAutoPay) {
    if (blockedPlans.has(inst.planId)) continue; // não se salta parcelas: se a anterior falhou, esta espera
    try {
      await settleInstallments(inst.planId, [inst.id], { actor: 'autopay', now });
      stats.autoPaid++;
    } catch (err) {
      blockedPlans.add(inst.planId);
      await prisma.installment.update({ where: { id: inst.id }, data: { lastAutoPayAttemptAt: now } }).catch(() => {});
      if (err && err.name === 'InsufficientFundsError') {
        stats.autoPayFailed++;
        if (!inst.lastAutoPayAttemptAt) {
          notifSvc.push(inst.plan.buyerId, {
            type: 'WARNING', category: 'system', title: 'Não foi possível debitar a parcela',
            message: `Saldo insuficiente para a parcela ${inst.number} (${fmt(payable(inst))} MT) da encomenda #${short(inst.plan.orderId)}. Carrega a carteira para evitar multa.`, link: '/wallet'
          });
        }
      } else if (!(err instanceof AppError)) {
        logger.error(`[Installments.job.autopay] ${err && err.message}`);
      }
    }
  }

  // 3) Em atraso: passou a tolerância → multa única + ATRASADA
  const graceLimit = new Date(now.getTime() - rules.graceHours() * HOUR);
  const toOverdue = await prisma.installment.findMany({
    where: { status: 'PENDENTE', number: { gt: 0 }, dueDate: { lt: graceLimit }, plan: { status: { in: ['ACTIVE', 'DEFAULTED'] } } },
    include: { plan: { select: { id: true, buyerId: true, sellerId: true, orderId: true, count: true } } }, take: 500
  });
  for (const inst of toOverdue) {
    const fee = rules.lateFeeFor(inst.amount);
    const marked = await prisma.$transaction(async (tx) => {
      const claim = await tx.installment.updateMany({ where: { id: inst.id, status: 'PENDENTE' }, data: { status: 'ATRASADA', lateFee: fee, overdueNotifiedAt: now } });
      if (claim.count === 0) return false;
      if (fee > 0) await tx.installmentPlan.update({ where: { id: inst.planId }, data: { totalAmount: { increment: fee } } });
      return true;
    });
    if (!marked) continue;
    stats.overdue++;
    notifSvc.push(inst.plan.buyerId, {
      type: 'WARNING', category: 'system', title: 'Parcela em atraso',
      message: `A parcela ${inst.number}/${inst.plan.count} da encomenda #${short(inst.plan.orderId)} está em atraso${fee > 0 ? ` (multa de ${fmt(fee)} MT)` : ''}. Paga já para evitar o bloqueio de compras em parcelas.`, link: orderLink(inst.plan.orderId)
    });
    notifSvc.push(inst.plan.sellerId, {
      type: 'WARNING', category: 'orders', title: 'Cliente com parcela em atraso',
      message: `A parcela ${inst.number} da encomenda #${short(inst.plan.orderId)} está em atraso.`, link: orderLink(inst.plan.orderId)
    });
  }

  // 4) Incumprimento: atraso acima do limite → plano INCUMPRIDO (bloqueia novas compras em parcelas)
  const defaultLimit = new Date(now.getTime() - rules.defaultAfterDays() * 24 * HOUR);
  const toDefault = await prisma.installment.findMany({
    where: { status: 'ATRASADA', dueDate: { lt: defaultLimit }, plan: { status: 'ACTIVE' } },
    select: { planId: true, plan: { select: { buyerId: true, sellerId: true, orderId: true } } }, take: 500
  });
  const seen = new Set();
  for (const row of toDefault) {
    if (seen.has(row.planId)) continue;
    seen.add(row.planId);
    const claim = await prisma.installmentPlan.updateMany({ where: { id: row.planId, status: 'ACTIVE' }, data: { status: 'DEFAULTED' } });
    if (claim.count === 0) continue;
    stats.defaulted++;
    notifSvc.push(row.plan.buyerId, { type: 'ERROR', category: 'system', title: 'Compra em incumprimento', message: `A encomenda #${short(row.plan.orderId)} tem parcelas em atraso há mais de ${rules.defaultAfterDays()} dias. Compras em parcelas bloqueadas até regularizares.`, link: orderLink(row.plan.orderId) });
    notifSvc.push(row.plan.sellerId, { type: 'WARNING', category: 'orders', title: 'Plano em incumprimento', message: `O plano da encomenda #${short(row.plan.orderId)} passou a incumprido.`, link: orderLink(row.plan.orderId) });
  }

  // 5) Reembolsos pendentes: tenta de novo (o vendedor pode já ter carregado a carteira)
  const pendingRefunds = await prisma.installmentPlan.findMany({ where: { refundPendingAmount: { gt: 0 } }, select: { id: true }, take: 100 });
  for (const p of pendingRefunds) await refundPlan(p.id, { reason: 'reembolso pendente' }).catch(() => {});

  if (Object.values(stats).some((v) => v > 0)) logger.info(`[Installments.job] ${JSON.stringify(stats)}`);
  return stats;
}

// ─────────────────────────────────────────────────────────────────
// Consultas
// ─────────────────────────────────────────────────────────────────
const planInclude = {
  installments: { orderBy: { number: 'asc' } },
  order: { select: { id: true, total: true, status: true, createdAt: true, items: { select: { name: true, qty: true, imageUrl: true }, take: 3 }, bazar: { select: { id: true, name: true, slug: true } } } }
};

const withProgress = (plan) => {
  const open = plan.installments.filter((i) => OPEN.includes(i.status));
  const next = open[0] || null;
  const remaining = round2(open.reduce((s, i) => s + payable(i), 0));
  return { ...plan, remaining, nextInstallment: next ? { id: next.id, number: next.number, amount: payable(next), dueDate: next.dueDate, status: next.status } : null };
};

const listPlans = async (userId, { as = 'buyer', status, page = 1, limit = 20 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { [as === 'seller' ? 'sellerId' : 'buyerId']: userId, ...(status && { status }) };
  const [plans, total] = await Promise.all([
    prisma.installmentPlan.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include: planInclude }),
    prisma.installmentPlan.count({ where })
  ]);
  return { plans: plans.map(withProgress), meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) } };
};

const getPlan = async (user, planId) => {
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId }, include: planInclude });
  if (!plan) throw notFoundErr('Plano não encontrado.');
  if (plan.buyerId !== user.id && plan.sellerId !== user.id && user.role !== 'ADMIN') throw forbiddenErr();
  return withProgress(plan);
};

const getPlanByOrder = async (user, orderId) => {
  const plan = await prisma.installmentPlan.findUnique({ where: { orderId }, include: planInclude });
  if (!plan) return null;
  if (plan.buyerId !== user.id && plan.sellerId !== user.id && user.role !== 'ADMIN') throw forbiddenErr();
  return withProgress(plan);
};

/** Próximas parcelas do comprador (widget "a pagar") — atrasadas primeiro. */
const upcomingForBuyer = async (userId, { days = 30 } = {}) => {
  const until = new Date(Date.now() + days * 86400000);
  const rows = await prisma.installment.findMany({
    where: { status: { in: OPEN }, number: { gt: 0 }, plan: { buyerId: userId, status: { in: ['ACTIVE', 'DEFAULTED'] } }, dueDate: { lte: until } },
    orderBy: { dueDate: 'asc' }, take: 50,
    include: { plan: { select: { id: true, orderId: true, count: true, autoPay: true } } }
  });
  const items = rows.map((i) => ({ id: i.id, planId: i.planId, orderId: i.plan.orderId, number: i.number, of: i.plan.count, amount: payable(i), lateFee: i.lateFee, dueDate: i.dueDate, status: i.status, autoPay: i.plan.autoPay }));
  return { items, totalDue: round2(items.reduce((s, i) => s + i.amount, 0)), overdueCount: items.filter((i) => i.status === 'ATRASADA').length };
};

const setAutoPay = async (userId, planId, enabled) => {
  const claim = await prisma.installmentPlan.updateMany({ where: { id: planId, buyerId: userId, status: { in: ['ACTIVE', 'DEFAULTED'] } }, data: { autoPay: Boolean(enabled) } });
  if (claim.count === 0) throw notFoundErr('Plano não encontrado ou já terminado.');
  return { autoPay: Boolean(enabled) };
};

const sellerSummary = async (sellerId) => {
  const [byStatus, openRows, refundPending] = await Promise.all([
    prisma.installmentPlan.groupBy({ by: ['status'], where: { sellerId }, _count: { _all: true }, _sum: { totalAmount: true, paidAmount: true } }),
    prisma.installment.findMany({ where: { status: { in: OPEN }, plan: { sellerId, status: { in: ['ACTIVE', 'DEFAULTED'] } } }, select: { amount: true, lateFee: true, status: true } }),
    prisma.installmentPlan.aggregate({ where: { sellerId, refundPendingAmount: { gt: 0 } }, _sum: { refundPendingAmount: true } })
  ]);
  const toReceive = round2(openRows.reduce((s, i) => s + payable(i), 0));
  const overdue = round2(openRows.filter((i) => i.status === 'ATRASADA').reduce((s, i) => s + payable(i), 0));
  return {
    byStatus: byStatus.map((g) => ({ status: g.status, plans: g._count._all, total: g._sum.totalAmount || 0, paid: g._sum.paidAmount || 0 })),
    toReceive, overdue, refundPending: refundPending._sum.refundPendingAmount || 0
  };
};

const adminOverview = async () => {
  const [byStatus, overdue, refundPending] = await Promise.all([
    prisma.installmentPlan.groupBy({ by: ['status'], _count: { _all: true }, _sum: { totalAmount: true, paidAmount: true } }),
    prisma.installment.aggregate({ where: { status: 'ATRASADA' }, _sum: { amount: true, lateFee: true }, _count: { _all: true } }),
    prisma.installmentPlan.aggregate({ where: { refundPendingAmount: { gt: 0 } }, _sum: { refundPendingAmount: true }, _count: { _all: true } })
  ]);
  return {
    byStatus: byStatus.map((g) => ({ status: g.status, plans: g._count._all, total: g._sum.totalAmount || 0, paid: g._sum.paidAmount || 0 })),
    overdue: { installments: overdue._count._all, amount: round2((overdue._sum.amount || 0) + (overdue._sum.lateFee || 0)) },
    refundPending: { plans: refundPending._count._all, amount: refundPending._sum.refundPendingAmount || 0 }
  };
};

module.exports = {
  movePayment, getSettings, saveSettings, publicSettingsFor, DEFAULT_SETTING,
  assertBuyerEligible, createPlanTx, settleInstallments, resolvePayTargets,
  cancelPlanTx, refundPlan, requestRefund, runInstallmentJob,
  listPlans, getPlan, getPlanByOrder, upcomingForBuyer, setAutoPay, sellerSummary, adminOverview
};
