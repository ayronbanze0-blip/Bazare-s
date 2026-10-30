'use strict';

/**
 * Encomendas nunca ficam presas. A cada 30 min:
 *   - PENDENTE há mais de ORDER_AUTO_CANCEL_HOURS (48 h) sem resposta do vendedor → cancelada
 *     (o stock volta, o cupão é devolvido, as parcelas/pagamentos são reembolsados).
 *   - EM_ENTREGA há mais de ORDER_AUTO_CONFIRM_DAYS (3 dias) sem confirmação → entregue
 *     (conta como venda, liberta a avaliação).
 * Põe um valor 0 numa das variáveis para desligar esse passo.
 * Reutiliza o MESMO handler de PATCH /orders/:id/status — as regras (transacção, stock, notificações,
 * histórico) vivem num só sítio. Cada encomenda é tratada em separado: uma falha não pára as outras.
 */
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { noOverlap } = require('../utils/noOverlap');

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const CANCEL_HOURS = num(process.env.ORDER_AUTO_CANCEL_HOURS, 48);
const CONFIRM_DAYS = num(process.env.ORDER_AUTO_CONFIRM_DAYS, 3);
const BATCH = 50;

// Chama o handler Express dentro do processo, como se fosse o próprio utilizador.
const callUpdateStatus = (userId, orderId, body) => new Promise((resolve) => {
  const handler = require('../controllers/orderController').updateStatus;
  const req = { user: { id: userId, role: 'SELLER' }, params: { id: orderId }, query: {}, body, headers: {}, ip: 'system', id: 'order-job' };
  const out = { code: 200 };
  const res = {
    status(c) { out.code = c; return res; },
    json(b) { resolve({ ok: out.code < 400 && !!(b && b.success !== false), code: out.code }); return res; },
    send() { resolve({ ok: out.code < 400, code: out.code }); return res; }
  };
  Promise.resolve(handler(req, res)).catch(() => resolve({ ok: false, code: 500 }));
});

async function runOrderJob() {
  if (CANCEL_HOURS > 0) {
    const before = new Date(Date.now() - CANCEL_HOURS * 3600 * 1000);
    const stale = await prisma.order.findMany({
      where: { status: 'PENDENTE', createdAt: { lt: before } },
      select: { id: true, sellerId: true }, take: BATCH, orderBy: { createdAt: 'asc' }
    });
    for (const o of stale) {
      // Como vendedor (não penaliza o comprador). Motivo fica no histórico e na notificação.
      const r = await callUpdateStatus(o.sellerId, o.id, { status: 'CANCELADA', cancelReason: 'Cancelada automaticamente: o vendedor não respondeu a tempo.' });
      if (!r.ok) logger.warn(`[orderJobs] auto-cancel falhou (${o.id}, ${r.code})`);
    }
    if (stale.length) logger.info(`[orderJobs] ${stale.length} encomenda(s) sem resposta canceladas.`);
  }
  if (CONFIRM_DAYS > 0) {
    const before = new Date(Date.now() - CONFIRM_DAYS * 86400 * 1000);
    const stuck = await prisma.order.findMany({
      where: { status: 'EM_ENTREGA', updatedAt: { lt: before } },
      select: { id: true, buyerId: true }, take: BATCH, orderBy: { updatedAt: 'asc' }
    });
    for (const o of stuck) {
      const r = await callUpdateStatus(o.buyerId, o.id, { status: 'ENTREGUE' });
      if (!r.ok) logger.warn(`[orderJobs] auto-confirmação falhou (${o.id}, ${r.code})`);
    }
    if (stuck.length) logger.info(`[orderJobs] ${stuck.length} encomenda(s) em entrega confirmadas automaticamente.`);
  }
}

function scheduleOrderJobs() {
  const safe = noOverlap(async () => { try { await runOrderJob(); } catch (err) { logger.error(`[orderJobs] ${err.message}`); } });
  const timers = [setTimeout(safe, 120 * 1000), setInterval(safe, 30 * 60 * 1000)];
  timers.forEach((t) => t.unref && t.unref());
  return timers;
}

module.exports = { scheduleOrderJobs, runOrderJob };
