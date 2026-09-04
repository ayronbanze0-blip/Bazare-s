'use strict';

const crypto = require('crypto');
const { ok, created, badRequest, notFound, validationError, serverError } = require('../utils/response');
const prisma = require('../config/database');
const logger = require('../utils/logger');

const VALID_EVENTS = ['ORDER_STATUS_CHANGED', 'COMMISSION_PAID', 'PREMIUM_ACTIVATED'];

// ─── GET /api/webhooks — lista as subscrições do próprio utilizador ──
// Nunca devolve o `secret` de volta (só é mostrado uma vez, na
// criação) — exactamente como uma chave de API normal.
const list = async (req, res) => {
  try {
    const subs = await prisma.webhookSubscription.findMany({
      where: { userId: req.user.id },
      select: { id: true, url: true, events: true, active: true, createdAt: true }
    });
    return ok(res, { subscriptions: subs });
  } catch (err) {
    logger.error(`[Webhooks.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/webhooks  { url, events: [...] } ────────────────────
const create = async (req, res) => {
  try {
    const { url, events } = req.body || {};

    if (!url || !/^https:\/\/.+/.test(url)) {
      return validationError(res, { url: 'URL inválido — tem de começar por https://' });
    }
    if (!Array.isArray(events) || events.length === 0 || events.some((e) => !VALID_EVENTS.includes(e))) {
      return validationError(res, { events: `Eventos válidos: ${VALID_EVENTS.join(', ')}` });
    }

    // Gerado uma única vez, mostrado ao utilizador só nesta resposta —
    // se o perder, tem de apagar a subscrição e criar outra.
    const secret = crypto.randomBytes(32).toString('hex');

    const sub = await prisma.webhookSubscription.create({
      data: { userId: req.user.id, url, events, secret }
    });

    logger.info(`[Webhooks] Nova subscrição criada por ${req.user.id}: ${url} (${events.join(', ')})`);
    return created(res, {
      subscription: { id: sub.id, url: sub.url, events: sub.events, active: sub.active, createdAt: sub.createdAt },
      secret // única vez que aparece — o frontend deve avisar o utilizador para o guardar já
    }, 'Subscrição criada. Guarda o "secret" agora — não voltará a ser mostrado.');
  } catch (err) {
    logger.error(`[Webhooks.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── PATCH /api/webhooks/:id  { active: boolean } ──────────────────
const update = async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return validationError(res, { active: 'active deve ser true ou false' });

    const sub = await prisma.webhookSubscription.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!sub) return notFound(res, 'Subscrição não encontrada.');

    const updated = await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { active } });
    return ok(res, { subscription: { id: updated.id, url: updated.url, events: updated.events, active: updated.active } });
  } catch (err) {
    logger.error(`[Webhooks.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/webhooks/:id ───────────────────────────────────────
const remove = async (req, res) => {
  try {
    const sub = await prisma.webhookSubscription.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!sub) return notFound(res, 'Subscrição não encontrada.');

    await prisma.webhookSubscription.delete({ where: { id: sub.id } });
    return ok(res, {}, 'Subscrição removida.');
  } catch (err) {
    logger.error(`[Webhooks.remove] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/webhooks/:id/deliveries — histórico de entregas ──────
// Útil para o vendedor perceber porque é que o sistema dele não está
// a receber os avisos (ex.: ver que está tudo FALHADA por o URL
// devolver 404).
const deliveries = async (req, res) => {
  try {
    const sub = await prisma.webhookSubscription.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!sub) return notFound(res, 'Subscrição não encontrada.');

    const items = await prisma.webhookDelivery.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, event: true, status: true, httpStatus: true, attempts: true, lastError: true, createdAt: true, deliveredAt: true }
    });
    return ok(res, { deliveries: items });
  } catch (err) {
    logger.error(`[Webhooks.deliveries] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, create, update, remove, deliveries, VALID_EVENTS };
