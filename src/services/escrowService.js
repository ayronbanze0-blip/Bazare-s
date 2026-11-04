'use strict';

/**
 * COMPRA SEGURA COM CÓDIGO (dinheiro retido) — paymentMode = 'SEGURA'.
 *
 *   1. O comprador faz o pedido (estado PENDENTE) — nada é cobrado.
 *   2. O vendedor ACEITA (ACEITE, à espera de pagamento) ou RECUSA. O comprador tem `payDeadline` para pagar.
 *   3. O comprador PAGA com o PIN da carteira: o valor sai da carteira dele e fica RETIDO (`escrowState = RETIDO`).
 *      O vendedor ainda NÃO recebe nada. É gerado um código de 6 dígitos que só o comprador vê.
 *   4. Na troca cara a cara, o comprador confere o produto e só então mostra o código.
 *   5. O vendedor introduz o código → o dinheiro é LIBERTADO para a carteira dele (encomenda ENTREGUE).
 *
 * Saídas: recusado, expirado, cancelado, em disputa (dinheiro CONGELADO até um admin decidir), reembolsado.
 *
 * Princípios (os mesmos de walletService/walletFlowService):
 *  - Todo o movimento de saldo passa por walletService.credit/debit DENTRO de uma $transaction, juntamente com o
 *    "claim" atómico do estado da encomenda (updateMany com condição). Débito + retenção + registo = 1 transacção.
 *  - Duplo toque / pedidos repetidos só actuam uma vez: o claim falha na 2.ª chamada e devolvemos o resultado já existente.
 *  - O PIN é verificado FORA da transacção (as tentativas falhadas têm de persistir).
 *  - O código NUNCA é guardado. Deriva-se com HMAC-SHA256(segredo do servidor, orderId + nonce). Assim o comprador pode
 *    voltar a vê-lo (GET /orders/:id/delivery-code) e, numa fuga da base de dados, os códigos não se leem (falta o segredo).
 *  - Tentativas de código: a tentativa é RESERVADA (incremento atómico) ANTES de comparar — pedidos em paralelo não
 *    conseguem fazer mais de MAX tentativas.
 */

const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const notifSvc = require('./notificationService');
const walletService = require('./walletService');
const walletFlow = require('./walletFlowService');
const couponSvc = require('./couponService');
const eventBus = require('./eventBus');
const V = require('../utils/validate');
const { AppError, bad, notFoundErr, conflictErr } = require('../utils/appError');
const { envEnabled } = require('../config/features');

// ─── Configuração (todas por variável de ambiente, com omissões do documento de requisitos) ───────────────
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const ACCEPT_HOURS = () => num(process.env.ESCROW_ACCEPT_HOURS, 24);      // vendedor responde em
const PAY_HOURS = () => num(process.env.ESCROW_PAY_HOURS, 24);            // comprador paga em (depois de aceite)
const DELIVERY_HOURS = () => num(process.env.ESCROW_DELIVERY_HOURS, 72);  // encontro acontece em (depois de pago)
const MAX_CODE_ATTEMPTS = () => Math.max(1, Math.floor(num(process.env.ESCROW_CODE_MAX_ATTEMPTS, 5)));
const CODE_LOCK_MIN = () => Math.max(1, num(process.env.ESCROW_CODE_LOCK_MIN, 30));
const FEE_PCT = () => 0; // a comissão da Bazares (3%) cobra-se no LEVANTAMENTO (walletFlowService.withdrawFee), nunca na libertação

const REASONS = ['NOT_RECEIVED', 'NOT_AS_DESCRIBED', 'DAMAGED', 'WRONG_ITEM', 'OTHER'];
const OPEN_DISPUTE_STATES = ['OPEN', 'SELLER_RESPONDED'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const short = (id) => String(id).slice(-8);
const fmt = (n) => Number(n).toLocaleString('pt-MZ');
const hoursFromNow = (h, from = new Date()) => new Date(from.getTime() + h * 3600 * 1000);

// ═════════════════════════════════════════════════════════════════
// Código de entrega
// ═════════════════════════════════════════════════════════════════
const codeSecret = () => {
  const s = process.env.ESCROW_CODE_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!s) throw new AppError('Compra segura temporariamente indisponível.', 503, 'ESCROW_NOT_CONFIGURED');
  return s;
};

/** Código de 6 dígitos, determinístico para (encomenda, nonce) — nunca é guardado. */
function deriveCode(orderId, nonce) {
  const h = crypto.createHmac('sha256', codeSecret()).update(`${orderId}:${nonce}`).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function codesMatch(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Aceita "123 456", "123-456"… e devolve só os 6 dígitos (ou null). */
const normalizeCode = (raw) => {
  const s = String(raw === undefined || raw === null ? '' : raw).replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
};

// ═════════════════════════════════════════════════════════════════
// Apresentação (nunca expor segredos do código)
// ═════════════════════════════════════════════════════════════════
/** Remove os campos internos do código e junta um resumo `escrow` (só para encomendas SEGURA). */
function publicOrder(o) {
  if (!o || typeof o !== 'object') return o;
  const { codeNonce, payIdempotencyKey, codeAttempts, ...rest } = o;
  if (o.paymentMode === 'SEGURA') {
    rest.escrow = {
      state: o.escrowState || null,
      amount: o.escrowAmount || 0,
      acceptedAt: o.acceptedAt || null,
      payDeadline: o.payDeadline || null,
      paidAt: o.paidAt || null,
      deliveryDeadline: o.deliveryDeadline || null,
      releasedAt: o.releasedAt || null,
      codeLockedUntil: o.codeLockedUntil || null,
      closedKind: o.closedKind || null
    };
  }
  return rest;
}

const loadSecure = async (orderId, include) => {
  const order = await prisma.order.findUnique({ where: { id: orderId }, ...(include ? { include } : {}) });
  if (!order) throw notFoundErr('Encomenda não encontrada.');
  if (order.paymentMode !== 'SEGURA') throw bad('Esta encomenda não é uma compra segura.', 'NOT_SECURE_ORDER');
  return order;
};

const emitChanged = (order, status, from) => {
  try {
    eventBus.emit(eventBus.EVENTS.ORDER_STATUS_CHANGED, {
      orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, status, from: from || order.status
    });
  } catch (e) { logger.warn(`[Escrow] evento não emitido: ${e.message}`); }
};

const paymentsEnabled = async () => {
  if (!envEnabled('ENABLE_PAYMENTS')) return false;
  try { return await require('./featureFlags').isEnabled('enable_payments', true); } catch { return true; }
};

// ═════════════════════════════════════════════════════════════════
// 1) Vendedor aceita
// ═════════════════════════════════════════════════════════════════
async function accept(sellerId, orderId) {
  const order = await loadSecure(orderId);
  if (order.sellerId !== sellerId) throw notFoundErr('Encomenda não encontrada.');
  if (order.status === 'ACEITE') return { order: publicOrder(order), already: true };
  if (order.status !== 'PENDENTE') throw conflictErr('Este pedido já não está à espera da tua resposta.', 'ORDER_NOT_PENDING');

  const now = new Date();
  const payDeadline = hoursFromNow(PAY_HOURS(), now);
  await prisma.$transaction(async (tx) => {
    const claim = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDENTE' },
      data: { status: 'ACEITE', acceptedAt: now, payDeadline }
    });
    if (claim.count === 0) throw conflictErr('Este pedido já não está à espera da tua resposta.', 'ORDER_NOT_PENDING');
    await tx.orderStatusHistory.create({ data: { orderId, status: 'ACEITE', actorId: sellerId, actorRole: 'seller', note: 'Pedido aceite — à espera do pagamento' } });
  });

  notifSvc.push(order.buyerId, {
    type: 'ORDER', category: 'orders', title: 'Pedido aceite — o produto continua em stock',
    message: `O vendedor aceitou o pedido #${short(orderId)}. Paga dentro da app para reservar: o dinheiro fica retido até à entrega.`,
    link: `order-detail.html?id=${orderId}`
  });
  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  emitChanged(updated, 'ACEITE', 'PENDENTE');
  return { order: publicOrder(updated) };
}

// ═════════════════════════════════════════════════════════════════
// 2) Comprador paga com o PIN → dinheiro retido + código
// ═════════════════════════════════════════════════════════════════
async function pay(buyerId, orderId, { pin, idempotencyKey } = {}) {
  const order = await loadSecure(orderId);
  if (order.buyerId !== buyerId) throw notFoundErr('Encomenda não encontrada.');

  // Duplo toque / repetição: o dinheiro já está retido → devolve o mesmo resultado (sem cobrar outra vez).
  if (order.escrowState) return { order: publicOrder(order), already: true, deliveryCode: order.escrowState === 'RETIDO' || order.escrowState === 'CONGELADO' ? deriveCode(order.id, order.codeNonce) : undefined };

  if (order.status === 'PENDENTE') throw conflictErr('O vendedor ainda não aceitou este pedido.', 'ORDER_NOT_ACCEPTED');
  if (order.status !== 'ACEITE') throw conflictErr('Este pedido já não pode ser pago.', 'ORDER_NOT_PAYABLE');
  const now = new Date();
  if (order.payDeadline && order.payDeadline.getTime() < now.getTime()) {
    throw conflictErr('O prazo para pagar terminou: o pedido expirou.', 'PAY_WINDOW_EXPIRED');
  }
  if (!(await paymentsEnabled())) throw new AppError('Pagamentos com a carteira temporariamente indisponíveis.', 503, 'FEATURE_DISABLED');

  const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 80) || null : null;
  await walletFlow.verifyPin(buyerId, typeof pin === 'string' ? pin : ''); // fora da transacção

  const nonce = crypto.randomBytes(16).toString('hex');
  const amount = round2(order.total);
  const deliveryDeadline = hoursFromNow(DELIVERY_HOURS(), now);

  try {
    await prisma.$transaction(async (tx) => {
      // Claim atómico: só UM pedido passa daqui (os restantes recebem count 0).
      const claim = await tx.order.updateMany({
        where: { id: orderId, buyerId, status: 'ACEITE', escrowState: null },
        data: {
          escrowState: 'RETIDO', escrowAmount: amount, paidAt: now, deliveryDeadline,
          codeNonce: nonce, codeAttempts: 0, codeLockedUntil: null, payIdempotencyKey: key
        }
      });
      if (claim.count === 0) throw new AlreadyHandled();

      await walletService.debit(tx, {
        userId: buyerId, amount, type: 'PAGAMENTO_COMPRA',
        description: `Compra segura #${short(orderId)} — dinheiro retido até à entrega`,
        referenceType: 'ORDER_ESCROW', referenceId: orderId
      });
      await tx.orderStatusHistory.create({ data: { orderId, status: 'ACEITE', actorId: buyerId, actorRole: 'buyer', note: 'Pago e retido — o vendedor só recebe com o código de entrega' } });
    }, { timeout: 15000, maxWait: 8000 });
  } catch (err) {
    if (err instanceof AlreadyHandled) {
      const again = await prisma.order.findUnique({ where: { id: orderId } });
      if (again && again.escrowState && again.buyerId === buyerId) {
        return { order: publicOrder(again), already: true, deliveryCode: again.escrowState === 'RETIDO' || again.escrowState === 'CONGELADO' ? deriveCode(again.id, again.codeNonce) : undefined };
      }
      throw conflictErr('Este pedido já não pode ser pago.', 'ORDER_NOT_PAYABLE');
    }
    if (err && err.name === 'InsufficientFundsError') throw new AppError(err.message, 400, 'INSUFFICIENT_FUNDS', { required: amount });
    throw err;
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  notifSvc.push(order.sellerId, {
    type: 'ORDER', category: 'orders', title: 'Pago e retido — combina a entrega',
    message: `O comprador pagou ${fmt(amount)} MT (pedido #${short(orderId)}). Recebes o dinheiro quando introduzires o código na entrega.`,
    link: `order-detail.html?id=${orderId}`
  });
  notifSvc.push(buyerId, {
    type: 'ORDER', category: 'orders', title: 'Dinheiro retido — guarda o teu código',
    message: `Os ${fmt(amount)} MT ficam retidos. Só mostres o código ao vendedor depois de conferires o produto na mão.`,
    link: `order-detail.html?id=${orderId}`
  });
  emitChanged(updated, 'ACEITE', 'ACEITE');
  logger.info(`[Escrow] pago e retido: ${orderId} (${amount} MT) por ${buyerId}`);
  return { order: publicOrder(updated), deliveryCode: deriveCode(updated.id, updated.codeNonce) };
}

class AlreadyHandled extends Error {}

// ═════════════════════════════════════════════════════════════════
// 3) Comprador vê o código (nunca o vendedor)
// ═════════════════════════════════════════════════════════════════
async function getDeliveryCode(buyerId, orderId) {
  const order = await loadSecure(orderId);
  if (order.buyerId !== buyerId) throw notFoundErr('Encomenda não encontrada.'); // o vendedor também cai aqui
  if (order.escrowState === 'LIBERTADO') throw conflictErr('Esta encomenda já foi concluída.', 'ORDER_COMPLETED');
  if (order.escrowState !== 'RETIDO' && order.escrowState !== 'CONGELADO') throw conflictErr('Ainda não pagaste esta encomenda.', 'ORDER_NOT_PAID');
  return {
    code: deriveCode(order.id, order.codeNonce),
    deliveryDeadline: order.deliveryDeadline,
    warning: 'Só mostre o código depois de conferir o produto na mão.'
  };
}

// ═════════════════════════════════════════════════════════════════
// Efeitos financeiros partilhados: libertação total/parcial ao vendedor
// ═════════════════════════════════════════════════════════════════
/**
 * Fecha a venda dentro de uma transacção. `refund` (>0) volta ao comprador; o resto vai para o vendedor, menos a
 * comissão (calculada AQUI, no momento da libertação). Regista Transaction VENDA, vendas do bazar e do produto.
 */
async function settleTx(tx, order, { refund = 0, platformAdminId = null } = {}) {
  const escrow = round2(order.escrowAmount);
  const refundAmt = Math.min(escrow, round2(refund));
  const toSeller = round2(escrow - refundAmt);
  let fee = 0;

  if (refundAmt > 0) {
    await walletService.credit(tx, {
      userId: order.buyerId, amount: refundAmt, type: 'REEMBOLSO_COMPRA',
      description: `Reembolso da compra segura #${short(order.id)}`,
      referenceType: 'ORDER_ESCROW', referenceId: order.id
    });
  }

  if (toSeller > 0) {
    const itemsBase = Math.max(0, round2(order.subtotal - (order.discountAmount || 0)));
    const base = escrow > 0 ? itemsBase * (toSeller / escrow) : 0;
    // Sem admin para receber a comissão → não se retém nada (o ledger nunca perde dinheiro).
    fee = platformAdminId ? Math.min(toSeller, round2(base * (FEE_PCT() / 100))) : 0;
    const net = round2(toSeller - fee);
    if (net > 0) {
      await walletService.credit(tx, {
        userId: order.sellerId, amount: net, type: 'RECEBIMENTO_VENDA',
        description: `Venda #${short(order.id)} — código validado`,
        referenceType: 'ORDER_ESCROW', referenceId: order.id
      });
    }
    if (fee > 0) {
      await walletService.credit(tx, {
        userId: platformAdminId, amount: fee, type: 'CREDITO_COMISSAO',
        description: `Comissão da venda #${short(order.id)}`,
        referenceType: 'ORDER_ESCROW_FEE', referenceId: order.id
      });
    }

    const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
    await tx.bazar.update({ where: { id: order.bazarId }, data: { totalSales: { increment: toSeller } } });
    await tx.transaction.create({
      data: {
        bazarId: order.bazarId, orderId: order.id, sellerId: order.sellerId, type: 'VENDA', amount: toSeller, fee,
        description: `Venda: ${items.map((i) => `${i.name} ×${i.qty}`).join(', ') || order.id}`
      }
    });
    for (const i of items) {
      await tx.product.update({ where: { id: i.productId }, data: { sales: { increment: i.qty } } }).catch(() => {}); // produto apagado
    }
  }
  return { toSeller, refund: refundAmt, fee };
}

const platformAdminIdIfNeeded = async () => {
  if (!(FEE_PCT() > 0)) return null;
  try { return (await walletService.getPlatformAdmin(prisma)).id; } catch (e) { logger.warn(`[Escrow] sem admin para comissão: ${e.message}`); return null; }
};

// ═════════════════════════════════════════════════════════════════
// 4) Vendedor introduz o código → dinheiro libertado
// ═════════════════════════════════════════════════════════════════
async function release(sellerId, orderId, rawCode) {
  const order = await loadSecure(orderId);
  if (order.sellerId !== sellerId) throw notFoundErr('Encomenda não encontrada.');
  if (order.escrowState === 'LIBERTADO') return { order: publicOrder(order), already: true };
  if (order.escrowState === 'CONGELADO') throw conflictErr('Esta encomenda está em disputa: o dinheiro está congelado até à decisão da Bazares.', 'ORDER_IN_DISPUTE');
  if (order.escrowState !== 'RETIDO' || order.status !== 'ACEITE') throw conflictErr('O comprador ainda não pagou esta encomenda.', 'ORDER_NOT_PAID');

  const now = new Date();
  if (order.deliveryDeadline && order.deliveryDeadline.getTime() < now.getTime()) {
    throw conflictErr('O prazo de entrega terminou: o dinheiro volta ao comprador.', 'DELIVERY_WINDOW_EXPIRED');
  }
  const code = normalizeCode(rawCode);
  if (!code) throw bad('O código tem 6 dígitos.', 'CODE_FORMAT'); // formato inválido não gasta tentativas

  // Reserva a tentativa ANTES de comparar (atómico): pedidos em paralelo não passam do máximo.
  const max = MAX_CODE_ATTEMPTS();
  const reserve = await prisma.order.updateMany({
    where: { id: orderId, escrowState: 'RETIDO', codeAttempts: { lt: max }, OR: [{ codeLockedUntil: null }, { codeLockedUntil: { lte: now } }] },
    data: { codeAttempts: { increment: 1 } }
  });
  if (reserve.count === 0) {
    const cur = await prisma.order.findUnique({ where: { id: orderId }, select: { codeLockedUntil: true, codeAttempts: true, escrowState: true } });
    if (!cur || cur.escrowState !== 'RETIDO') throw conflictErr('Esta encomenda já não aceita códigos.', 'ORDER_NOT_PAID');
    let lockedUntil = cur.codeLockedUntil && cur.codeLockedUntil.getTime() > now.getTime() ? cur.codeLockedUntil : null;
    if (!lockedUntil && cur.codeAttempts >= max) {
      // Máximo atingido mas o bloqueio ainda não foi gravado (pedido concorrente a meio, ou falha entre os dois passos):
      // grava-o agora — assim a encomenda nunca fica presa num limbo sem bloqueio e sem tentativas.
      lockedUntil = new Date(now.getTime() + CODE_LOCK_MIN() * 60000);
      await prisma.order.updateMany({ where: { id: orderId, codeAttempts: { gte: max }, OR: [{ codeLockedUntil: null }, { codeLockedUntil: { lte: now } }] }, data: { codeAttempts: 0, codeLockedUntil: lockedUntil } });
    }
    if (lockedUntil) {
      const min = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000));
      throw new AppError(`Demasiados códigos errados. Tenta de novo daqui a ${min} min.`, 429, 'CODE_LOCKED', { retryAfterMin: min });
    }
    throw conflictErr('Esta encomenda já não aceita códigos.', 'ORDER_NOT_PAID');
  }

  if (!codesMatch(code, deriveCode(order.id, order.codeNonce))) {
    const cur = await prisma.order.findUnique({ where: { id: orderId }, select: { codeAttempts: true } });
    const used = cur ? cur.codeAttempts : max;
    if (used >= max) {
      const lockedUntil = new Date(now.getTime() + CODE_LOCK_MIN() * 60000);
      await prisma.order.updateMany({ where: { id: orderId, codeAttempts: { gte: max } }, data: { codeAttempts: 0, codeLockedUntil: lockedUntil } });
      notifSvc.push(order.buyerId, {
        type: 'WARNING', category: 'orders', title: 'Códigos errados na tua encomenda',
        message: `Foram introduzidos ${max} códigos errados na encomenda #${short(orderId)}. A libertação ficou bloqueada ${CODE_LOCK_MIN()} min. Se não estás com o vendedor, não partilhes o código.`,
        link: `order-detail.html?id=${orderId}`
      });
      throw new AppError(`Código incorrecto ${max} vezes. Bloqueado durante ${CODE_LOCK_MIN()} min.`, 429, 'CODE_LOCKED', { retryAfterMin: CODE_LOCK_MIN() });
    }
    const left = max - used;
    throw new AppError(`Código incorrecto. Restam ${left} tentativa${left === 1 ? '' : 's'}.`, 400, 'CODE_INVALID', { attemptsLeft: left });
  }

  const platformAdminId = await platformAdminIdIfNeeded();
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: orderId, escrowState: 'RETIDO', status: 'ACEITE' },
        data: { escrowState: 'LIBERTADO', status: 'ENTREGUE', releasedAt: now, deliveredAt: now, codeAttempts: 0, codeLockedUntil: null }
      });
      if (claim.count === 0) throw new AlreadyHandled();
      const money = await settleTx(tx, order, { platformAdminId });
      await tx.order.update({ where: { id: orderId }, data: { feeAmount: money.fee } });
      await tx.orderStatusHistory.create({ data: { orderId, status: 'ENTREGUE', actorId: sellerId, actorRole: 'seller', note: 'Concluído — código validado, dinheiro libertado' } });
      return money;
    }, { timeout: 15000, maxWait: 8000 });
  } catch (err) {
    if (err instanceof AlreadyHandled) {
      const again = await prisma.order.findUnique({ where: { id: orderId } });
      if (again && again.escrowState === 'LIBERTADO') return { order: publicOrder(again), already: true };
      throw conflictErr('Esta encomenda já não aceita códigos.', 'ORDER_NOT_PAID');
    }
    throw err;
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  notifSvc.push(sellerId, {
    type: 'SUCCESS', category: 'orders', title: 'Dinheiro libertado',
    message: `${fmt(result.toSeller - result.fee)} MT da encomenda #${short(orderId)} já estão disponíveis na tua carteira.`,
    link: 'wallet.html'
  });
  notifSvc.push(order.buyerId, {
    type: 'SUCCESS', category: 'orders', title: 'Compra concluída',
    message: `A encomenda #${short(orderId)} foi concluída. Avalia o vendedor.`,
    link: `order-detail.html?id=${orderId}`
  });
  emitChanged(updated, 'ENTREGUE', 'ACEITE');
  logger.info(`[Escrow] libertado: ${orderId} → ${result.toSeller} MT (comissão ${result.fee}) vendedor ${sellerId}`);
  return { order: publicOrder(updated), released: result.toSeller - result.fee };
}

// ═════════════════════════════════════════════════════════════════
// Reembolso do dinheiro retido (cancelamento / expiração) — chamado DENTRO da transacção de updateStatus
// ═════════════════════════════════════════════════════════════════
async function refundTx(tx, order, { note = 'encomenda cancelada' } = {}) {
  const amount = round2(order.escrowAmount);
  if (!(amount > 0)) return 0;
  await walletService.credit(tx, {
    userId: order.buyerId, amount, type: 'REEMBOLSO_COMPRA',
    description: `Reembolso da compra segura #${short(order.id)} — ${note}`,
    referenceType: 'ORDER_ESCROW', referenceId: order.id
  });
  return amount;
}

/**
 * Valida o que PATCH /orders/:id/status pode fazer numa compra segura. Lança AppError se não puder.
 * Na compra segura a entrega só se conclui com o código; aceitar passa por /accept.
 */
function guardLegacyTransition(order, to) {
  if (order.paymentMode !== 'SEGURA') return;
  if (to === 'ACEITE') throw bad('Na compra segura usa "Aceitar pedido" (POST /orders/:id/accept).', 'USE_ACCEPT');
  if (to === 'EM_PREPARACAO' || to === 'EM_ENTREGA') throw bad('Na compra segura não há estados intermédios: a entrega faz-se cara a cara, com o código.', 'SECURE_FLOW_ONLY');
  if (to === 'ENTREGUE') throw bad('Na compra segura a entrega só se conclui quando o vendedor introduz o código do comprador.', 'CODE_REQUIRED');
  if (to === 'CANCELADA' && order.escrowState === 'CONGELADO') {
    throw new AppError('Esta encomenda está em disputa: o dinheiro está congelado até à decisão da Bazares.', 409, 'ORDER_IN_DISPUTE');
  }
}

// ═════════════════════════════════════════════════════════════════
// 5) Disputa — congela o dinheiro (comprador OU vendedor)
// ═════════════════════════════════════════════════════════════════
async function notifyAdmins(payload) {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true }, take: 20 });
  await Promise.all(admins.map((a) => notifSvc.push(a.id, { category: 'system', ...payload })));
}

async function openDispute(userId, order, body) {
  V.bodyObject(body);
  const reason = V.oneOf(body.reason, 'reason', REASONS);
  const description = V.text(body.description, 'description', { min: 10, max: 1500, multiline: true });
  const evidenceUrls = V.urls(body.evidenceUrls, 'evidenceUrls', { max: 5 });
  if (order.buyerId !== userId && order.sellerId !== userId) throw notFoundErr('Encomenda não encontrada.');
  if (order.escrowState === 'CONGELADO') throw conflictErr('Já existe uma disputa para esta encomenda.', 'DISPUTE_EXISTS');
  if (order.escrowState !== 'RETIDO') throw conflictErr('Só é possível abrir uma disputa quando o dinheiro está retido.', 'DISPUTE_NOT_ALLOWED');

  let dispute;
  try {
    dispute = await prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({ where: { id: order.id, escrowState: 'RETIDO' }, data: { escrowState: 'CONGELADO' } });
      if (claim.count === 0) throw conflictErr('Já existe uma disputa para esta encomenda.', 'DISPUTE_EXISTS');
      const d = await tx.orderDispute.create({
        data: { orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, reason, description, evidenceUrls, openedById: userId }
      });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, status: order.status, actorId: userId, actorRole: userId === order.buyerId ? 'buyer' : 'seller', note: 'Disputa aberta — dinheiro congelado' } });
      return d;
    });
  } catch (err) {
    if (err && err.code === 'P2002') throw conflictErr('Já existe uma disputa para esta encomenda.', 'DISPUTE_EXISTS');
    throw err;
  }

  const other = userId === order.buyerId ? order.sellerId : order.buyerId;
  notifSvc.push(other, { type: 'WARNING', category: 'orders', title: 'Disputa aberta — dinheiro congelado', message: `Foi aberta uma disputa na encomenda #${short(order.id)}. O dinheiro fica congelado até a Bazares decidir.`, link: `order-detail.html?id=${order.id}` });
  notifyAdmins({ type: 'INFO', title: 'Nova disputa (compra segura)', message: `Disputa na encomenda #${short(order.id)} (${reason}) — ${fmt(order.escrowAmount)} MT congelados.`, link: '/admin/disputes' }).catch(() => {});
  emitChanged({ ...order }, order.status, order.status);
  return dispute;
}

/**
 * Decisão do admin sobre uma disputa de compra segura (dinheiro CONGELADO).
 *  REJECT → o comprador não tem razão: dinheiro libertado ao vendedor.
 *  REFUND → reembolso total (encomenda cancelada, stock volta) ou parcial (o resto vai para o vendedor).
 */
async function resolveFrozen(admin, dispute, order, decision, resolution, body) {
  const escrow = round2(order.escrowAmount);
  let refund = 0;
  if (decision === 'REFUND') {
    refund = body.refundAmount === undefined ? escrow : V.money(body.refundAmount, 'refundAmount', { min: 0.01 });
    if (refund > escrow + 1e-9) throw bad(`O reembolso não pode passar do dinheiro retido (${fmt(escrow)} MT).`, 'REFUND_TOO_HIGH');
    refund = Math.min(refund, escrow);
  }
  const full = decision === 'REFUND' && Math.abs(refund - escrow) < 0.005;
  const restock = full ? V.bool(body.restock, 'restock', { def: true }) : false;
  const now = new Date();
  const platformAdminId = full ? null : await platformAdminIdIfNeeded();

  await prisma.$transaction(async (tx) => {
    const d = await tx.orderDispute.updateMany({
      where: { id: dispute.id, status: { in: OPEN_DISPUTE_STATES } },
      data: { status: decision === 'REFUND' ? 'RESOLVED_REFUND' : 'RESOLVED_REJECTED', resolution, resolvedById: admin.id, resolvedAt: now, ...(decision === 'REFUND' && { refundAmount: refund, restock }) }
    });
    if (d.count === 0) throw conflictErr('Esta disputa já foi encerrada.', 'DISPUTE_CLOSED');

    if (full) {
      const claim = await tx.order.updateMany({
        where: { id: order.id, escrowState: 'CONGELADO' },
        data: { escrowState: 'REEMBOLSADO', status: 'CANCELADA', cancelledAt: now, cancelReason: 'Disputa resolvida a favor do comprador.', closedKind: 'CANCELADO' }
      });
      if (claim.count === 0) throw conflictErr('O estado da encomenda mudou entretanto.', 'ORDER_STATE_CHANGED');
      await settleTx(tx, order, { refund: escrow });
      await couponSvc.revertForOrderTx(tx, order.id);
      if (restock) {
        const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
        for (const i of items) await tx.product.updateMany({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
      }
    } else {
      const claim = await tx.order.updateMany({
        where: { id: order.id, escrowState: 'CONGELADO' },
        data: { escrowState: 'LIBERTADO', status: 'ENTREGUE', releasedAt: now, deliveredAt: now }
      });
      if (claim.count === 0) throw conflictErr('O estado da encomenda mudou entretanto.', 'ORDER_STATE_CHANGED');
      const money = await settleTx(tx, order, { refund, platformAdminId });
      await tx.order.update({ where: { id: order.id }, data: { feeAmount: money.fee } });
    }
    await tx.orderStatusHistory.create({
      data: { orderId: order.id, status: full ? 'CANCELADA' : 'ENTREGUE', actorId: admin.id, actorRole: 'admin', note: `Disputa resolvida — ${full ? 'reembolso total ao comprador' : refund > 0 ? `reembolso parcial de ${fmt(refund)} MT` : 'dinheiro libertado ao vendedor'}` }
    });
  }, { timeout: 20000, maxWait: 8000 });

  const buyerMsg = decision === 'REFUND'
    ? `Reembolso de ${fmt(refund)} MT aprovado: o valor já voltou à tua carteira. ${resolution}`
    : `A disputa da encomenda #${short(order.id)} foi rejeitada e o dinheiro seguiu para o vendedor. ${resolution}`;
  const sellerMsg = decision === 'REFUND'
    ? (full ? `A disputa da encomenda #${short(order.id)} foi decidida a favor do comprador (reembolso total). ${resolution}` : `Disputa decidida: reembolso parcial de ${fmt(refund)} MT ao comprador; o resto foi libertado para ti. ${resolution}`)
    : `A disputa foi decidida a teu favor: ${fmt(escrow)} MT libertados na tua carteira. ${resolution}`;
  notifSvc.push(order.buyerId, { type: decision === 'REFUND' ? 'SUCCESS' : 'INFO', category: 'orders', title: 'Disputa decidida', message: buyerMsg.slice(0, 250), link: `order-detail.html?id=${order.id}` });
  notifSvc.push(order.sellerId, { type: decision === 'REFUND' ? 'WARNING' : 'SUCCESS', category: 'orders', title: 'Disputa decidida', message: sellerMsg.slice(0, 250), link: `order-detail.html?id=${order.id}` });
  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  emitChanged(updated, updated.status, 'ACEITE');
  logger.info(`[Escrow] disputa ${dispute.id} → ${decision} (${refund} MT) por admin ${admin.id}`);
  return { dispute: await prisma.orderDispute.findUnique({ where: { id: dispute.id } }), money: { refunded: refund, released: round2(escrow - refund) } };
}

// ═════════════════════════════════════════════════════════════════
// Carteira: saldos separados (retido como comprador / a libertar como vendedor)
// ═════════════════════════════════════════════════════════════════
async function walletTotals(userId) {
  const live = { paymentMode: 'SEGURA', escrowState: { in: ['RETIDO', 'CONGELADO'] } };
  const [buying, selling, frozen] = await Promise.all([
    prisma.order.aggregate({ where: { ...live, buyerId: userId }, _sum: { escrowAmount: true }, _count: true }),
    prisma.order.aggregate({ where: { ...live, sellerId: userId }, _sum: { escrowAmount: true }, _count: true }),
    prisma.order.count({ where: { paymentMode: 'SEGURA', escrowState: 'CONGELADO', OR: [{ buyerId: userId }, { sellerId: userId }] } })
  ]);
  return {
    held: round2(buying._sum.escrowAmount || 0), heldCount: buying._count || 0,         // pagaste e ainda não foi entregue
    toRelease: round2(selling._sum.escrowAmount || 0), toReleaseCount: selling._count || 0, // vais receber quando o comprador der o código
    inDispute: frozen
  };
}

module.exports = {
  REASONS, deriveCode, codesMatch, normalizeCode, publicOrder,
  accept, pay, getDeliveryCode, release, openDispute, resolveFrozen,
  refundTx, guardLegacyTransition, walletTotals,
  config: { ACCEPT_HOURS, PAY_HOURS, DELIVERY_HOURS, MAX_CODE_ATTEMPTS, CODE_LOCK_MIN, FEE_PCT }
};
