'use strict';

/**
 * Disputas / devoluções pós-compra.
 *   Comprador abre → vendedor responde → admin decide (reembolso total/parcial ou rejeitar).
 * Reembolso: se a encomenda foi paga com a carteira, o dinheiro volta ao comprador (debitado ao vendedor; se não
 * houver saldo fica pendente). Em pagamento na entrega a plataforma não move dinheiro — fica registado e ambos são
 * avisados. Comissão e vendas do vendedor são ajustadas proporcionalmente ao reembolso.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const notifSvc = require('./notificationService');
const installmentSvc = require('./installmentService');
const V = require('../utils/validate');
const { AppError, bad, notFoundErr, forbiddenErr, conflictErr } = require('../utils/appError');

const REASONS = ['NOT_RECEIVED', 'NOT_AS_DESCRIBED', 'DAMAGED', 'WRONG_ITEM', 'OTHER'];
const OPEN_STATES = ['OPEN', 'SELLER_RESPONDED'];
const windowDays = () => Math.max(1, parseInt(process.env.DISPUTE_WINDOW_DAYS, 10) || 7);
const notReceivedAfterDays = () => Math.max(1, parseInt(process.env.DISPUTE_NOT_RECEIVED_AFTER_DAYS, 10) || 3);
const short = (id) => String(id).slice(-8);
const fmt = (n) => Number(n).toLocaleString('pt-MZ');

async function notifyAdmins(payload) {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true }, take: 20 });
  await Promise.all(admins.map((a) => notifSvc.push(a.id, { category: 'system', ...payload })));
}

/** Pode o comprador abrir disputa agora? Devolve null se sim, ou o motivo (texto) se não. */
function whyCannotOpen(order, reason, now = new Date()) {
  const DAY = 86400000;
  if (order.status === 'ENTREGUE') {
    const ref = order.deliveredAt || order.updatedAt;
    if (now.getTime() - new Date(ref).getTime() > windowDays() * DAY) return `O prazo para abrir uma disputa (${windowDays()} dias após a entrega) já passou.`;
    return null;
  }
  if (order.status === 'EM_ENTREGA' && reason === 'NOT_RECEIVED') {
    if (now.getTime() - new Date(order.updatedAt).getTime() < notReceivedAfterDays() * DAY) return `Só podes dizer que não recebeste ao fim de ${notReceivedAfterDays()} dias em entrega.`;
    return null;
  }
  return 'Só é possível abrir uma disputa numa encomenda entregue (ou "não recebida" após alguns dias em entrega).';
}

const openDispute = async (buyerId, orderId, body) => {
  V.bodyObject(body);
  const reason = V.oneOf(body.reason, 'reason', REASONS);
  const description = V.text(body.description, 'description', { min: 10, max: 1500, multiline: true });
  const evidenceUrls = V.urls(body.evidenceUrls, 'evidenceUrls', { max: 5 });

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.buyerId !== buyerId) throw notFoundErr('Encomenda não encontrada.');
  const blockReason = whyCannotOpen(order, reason);
  if (blockReason) throw bad(blockReason, 'DISPUTE_NOT_ALLOWED');

  let dispute;
  try {
    dispute = await prisma.orderDispute.create({ data: { orderId, buyerId, sellerId: order.sellerId, reason, description, evidenceUrls } });
  } catch (err) {
    if (err.code === 'P2002') throw conflictErr('Já existe uma disputa para esta encomenda.', 'DISPUTE_EXISTS');
    throw err;
  }
  notifSvc.push(order.sellerId, { type: 'WARNING', category: 'orders', title: 'Disputa aberta', message: `O comprador abriu uma disputa na encomenda #${short(orderId)}. Responde o mais depressa possível.`, link: `order-detail.html?id=${orderId}` });
  notifyAdmins({ type: 'INFO', title: 'Nova disputa', message: `Disputa na encomenda #${short(orderId)} (${reason}).`, link: '/admin/disputes' }).catch(() => {});
  return dispute;
};

const respondDispute = async (sellerId, disputeId, body) => {
  V.bodyObject(body);
  const sellerResponse = V.text(body.response, 'response', { min: 5, max: 1500, multiline: true });
  const d = await prisma.orderDispute.findUnique({ where: { id: disputeId } });
  if (!d || d.sellerId !== sellerId) throw notFoundErr('Disputa não encontrada.');
  const claim = await prisma.orderDispute.updateMany({ where: { id: disputeId, status: { in: OPEN_STATES } }, data: { status: 'SELLER_RESPONDED', sellerResponse, respondedAt: new Date() } });
  if (claim.count === 0) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');
  notifSvc.push(d.buyerId, { type: 'INFO', category: 'orders', title: 'O vendedor respondeu', message: `Há uma resposta à tua disputa da encomenda #${short(d.orderId)}.`, link: `order-detail.html?id=${d.orderId}` });
  notifyAdmins({ type: 'INFO', title: 'Disputa com resposta', message: `Disputa #${short(d.id)} já tem resposta do vendedor.`, link: '/admin/disputes' }).catch(() => {});
  return prisma.orderDispute.findUnique({ where: { id: disputeId } });
};

const cancelDispute = async (buyerId, disputeId) => {
  const d = await prisma.orderDispute.findUnique({ where: { id: disputeId } });
  if (!d || d.buyerId !== buyerId) throw notFoundErr('Disputa não encontrada.');
  const claim = await prisma.orderDispute.updateMany({ where: { id: disputeId, status: { in: OPEN_STATES } }, data: { status: 'CANCELLED', resolvedAt: new Date(), resolution: 'Cancelada pelo comprador.' } });
  if (claim.count === 0) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');
  notifSvc.push(d.sellerId, { type: 'INFO', category: 'orders', title: 'Disputa cancelada', message: `O comprador cancelou a disputa da encomenda #${short(d.orderId)}.`, link: `order-detail.html?id=${d.orderId}` });
  return { cancelled: true };
};

/** Decisão do admin. decision: 'REFUND' | 'REJECT'. */
const resolveDispute = async (admin, disputeId, body) => {
  V.bodyObject(body);
  const decision = V.oneOf(body.decision, 'decision', ['REFUND', 'REJECT']);
  const resolution = V.text(body.resolution, 'resolution', { min: 5, max: 1500, multiline: true });

  const d = await prisma.orderDispute.findUnique({ where: { id: disputeId }, include: { order: { include: { items: true } } } });
  if (!d) throw notFoundErr('Disputa não encontrada.');
  if (!OPEN_STATES.includes(d.status)) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');
  const { order } = d;

  if (decision === 'REJECT') {
    const claim = await prisma.orderDispute.updateMany({ where: { id: disputeId, status: { in: OPEN_STATES } }, data: { status: 'RESOLVED_REJECTED', resolution, resolvedById: admin.id, resolvedAt: new Date() } });
    if (claim.count === 0) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');
    notifSvc.push(d.buyerId, { type: 'INFO', category: 'orders', title: 'Disputa analisada', message: `A tua disputa da encomenda #${short(order.id)} foi rejeitada. ${resolution}`.slice(0, 250), link: `order-detail.html?id=${order.id}` });
    notifSvc.push(d.sellerId, { type: 'SUCCESS', category: 'orders', title: 'Disputa resolvida a teu favor', message: `A disputa da encomenda #${short(order.id)} foi rejeitada.`, link: `order-detail.html?id=${order.id}` });
    return prisma.orderDispute.findUnique({ where: { id: disputeId } });
  }

  const refundAmount = body.refundAmount === undefined ? order.total : V.money(body.refundAmount, 'refundAmount', { min: 0.01 });
  if (refundAmount > order.total + 1e-9) throw bad(`O reembolso não pode passar do total da encomenda (${fmt(order.total)} MT).`, 'REFUND_TOO_HIGH');
  const full = Math.abs(refundAmount - order.total) < 0.005;
  const restock = full && V.bool(body.restock, 'restock', { def: false });

  await prisma.$transaction(async (tx) => {
    const claim = await tx.orderDispute.updateMany({
      where: { id: disputeId, status: { in: OPEN_STATES } },
      data: { status: 'RESOLVED_REFUND', resolution, refundAmount, restock, resolvedById: admin.id, resolvedAt: new Date() }
    });
    if (claim.count === 0) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');

    // Ajusta comissão e vendas do vendedor na proporção do reembolso
    const ratio = refundAmount / order.total;
    const feeBack = V.round2((order.feeAmount || 0) * ratio);
    const bazar = await tx.bazar.findUnique({ where: { id: order.bazarId }, select: { pendingFees: true } });
    const dec = Math.min(bazar ? bazar.pendingFees : 0, feeBack);
    await tx.bazar.update({ where: { id: order.bazarId }, data: { pendingFees: { decrement: dec }, totalSales: { decrement: refundAmount } } });
    await tx.transaction.create({
      data: { bazarId: order.bazarId, sellerId: order.sellerId, type: 'REEMBOLSO', amount: refundAmount, fee: -dec, description: `Reembolso (disputa) da encomenda #${short(order.id)}` }
    });
    if (restock) {
      for (const i of order.items) await tx.product.updateMany({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
    }
  });

  // Dinheiro: só há o que devolver se foi pago com a carteira
  let money = { refunded: 0, pending: 0, noPlan: true };
  const plan = await prisma.installmentPlan.findUnique({ where: { orderId: order.id }, select: { id: true } });
  if (plan) money = await installmentSvc.requestRefund(plan.id, refundAmount, { reason: 'disputa resolvida a favor do comprador' });

  const how = plan
    ? (money.pending > 0 ? 'O valor será devolvido à tua carteira assim que o vendedor tiver saldo.' : 'O valor já foi devolvido à tua carteira.')
    : 'Como pagaste na entrega, combina a devolução do dinheiro directamente com o vendedor.';
  notifSvc.push(d.buyerId, { type: 'SUCCESS', category: 'orders', title: 'Disputa resolvida a teu favor', message: `Reembolso de ${fmt(refundAmount)} MT aprovado. ${how}`.slice(0, 250), link: `order-detail.html?id=${order.id}` });
  notifSvc.push(d.sellerId, { type: 'WARNING', category: 'orders', title: 'Disputa resolvida: reembolso', message: `Foi aprovado um reembolso de ${fmt(refundAmount)} MT na encomenda #${short(order.id)}. ${resolution}`.slice(0, 250), link: `order-detail.html?id=${order.id}` });
  logger.info(`[Disputes] ${disputeId} → REEMBOLSO ${refundAmount} MT por admin ${admin.id}`);
  return { dispute: await prisma.orderDispute.findUnique({ where: { id: disputeId } }), money };
};

const disputeInclude = {
  order: { select: { id: true, total: true, status: true, deliveredAt: true, paymentMode: true, items: { select: { name: true, qty: true, imageUrl: true }, take: 3 } } },
  buyer: { select: { id: true, name: true, avatarUrl: true } },
  seller: { select: { id: true, name: true, avatarUrl: true } }
};

const listMine = async (userId, { as = 'buyer', status, page = 1, limit = 20 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { [as === 'seller' ? 'sellerId' : 'buyerId']: userId, ...(status && { status }) };
  const [rows, total] = await Promise.all([
    prisma.orderDispute.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include: disputeInclude }),
    prisma.orderDispute.count({ where })
  ]);
  return { disputes: rows, meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) } };
};

const getOne = async (user, id) => {
  const d = await prisma.orderDispute.findUnique({ where: { id }, include: disputeInclude });
  if (!d) throw notFoundErr('Disputa não encontrada.');
  if (d.buyerId !== user.id && d.sellerId !== user.id && user.role !== 'ADMIN') throw forbiddenErr();
  return d;
};

const adminList = async ({ status, page = 1, limit = 30 } = {}) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = status ? { status } : { status: { in: OPEN_STATES } };
  const [rows, total] = await Promise.all([
    prisma.orderDispute.findMany({ where, orderBy: { createdAt: 'asc' }, take, skip, include: disputeInclude }),
    prisma.orderDispute.count({ where })
  ]);
  return { disputes: rows, meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) } };
};

module.exports = { REASONS, whyCannotOpen, openDispute, respondDispute, cancelDispute, resolveDispute, listMine, getOne, adminList, AppError };
