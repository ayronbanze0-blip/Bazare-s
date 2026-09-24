'use strict';

/**
 * Idempotência de webhooks de pagamento — registo de eventos recebidos.
 *
 * Camadas de protecção (todas mantidas):
 *   1. Assinatura HMAC válida (zumboPayService.verifyWebhookSignature) — senão 401.
 *   2. ESTE serviço: cada evento (provider + eventKey) é gravado uma vez (UNIQUE). Um evento já
 *      PROCESSED é confirmado com 200 e NÃO é reprocessado.
 *   3. Claim atómico por estado dentro de transacção (updateMany ... status: 'PROCESSANDO') —
 *      continua a ser a garantia final contra entregas concorrentes do mesmo evento.
 *
 * Fail-open de propósito: se a tabela ainda não existir (migration por aplicar) ou a BD falhar
 * ao registar, o webhook continua a ser processado só com a camada 3 — nunca se perde um pagamento
 * por causa deste registo.
 */

const crypto = require('crypto');
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Chave estável do evento: id enviado pelo provider (+ tipo, porque alguns providers reutilizam o
 * id do pagamento em vários eventos) ou, na falta dele, o SHA-256 do corpo em bruto — reenvios
 * idênticos do mesmo evento produzem a mesma chave.
 */
function eventKeyFor(event, rawBody) {
  const id = event && (event.id || event.event_id || event.eventId || (event.data && event.data.event_id));
  const type = event && (event.type || event.event);
  if ((typeof id === 'string' || typeof id === 'number') && String(id).length > 0 && String(id).length <= 128) {
    return `id:${type || 'unknown'}:${id}`;
  }
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody));
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

const keyOf = (provider, eventKey) => ({ provider_eventKey: { provider, eventKey } });

/**
 * Regista a recepção. Devolve { duplicate, tracked }.
 *   duplicate=true  → já foi PROCESSED: responder 200 e parar.
 *   tracked=false   → não foi possível registar (fail-open): processar na mesma.
 */
async function begin(provider, eventKey, { type = null, reference = null } = {}) {
  try {
    await prisma.paymentWebhookEvent.create({
      data: { provider, eventKey, type: type ? String(type).slice(0, 80) : null, reference: reference ? String(reference).slice(0, 120) : null }
    });
    return { duplicate: false, tracked: true };
  } catch (err) {
    if (err && err.code === 'P2002') {
      try {
        const existing = await prisma.paymentWebhookEvent.findUnique({ where: keyOf(provider, eventKey) });
        if (existing && existing.status === 'PROCESSED') return { duplicate: true, tracked: true };
        await prisma.paymentWebhookEvent.update({
          where: keyOf(provider, eventKey),
          data: { attempts: { increment: 1 }, status: 'RECEIVED' }
        });
        return { duplicate: false, tracked: true };
      } catch (inner) {
        logger.warn(`[WebhookEvent] Falha ao ler evento existente: ${inner.message}`);
        return { duplicate: false, tracked: false };
      }
    }
    logger.error(`[WebhookEvent] Não foi possível registar o evento (a processar sem registo): ${err && err.message}`);
    return { duplicate: false, tracked: false };
  }
}

/** Marca o resultado. Nunca lança. */
async function finish(provider, eventKey, { ok, error = null } = {}) {
  try {
    await prisma.paymentWebhookEvent.update({
      where: keyOf(provider, eventKey),
      data: ok
        ? { status: 'PROCESSED', processedAt: new Date(), error: null }
        : { status: 'FAILED', error: error ? String(error).slice(0, 300) : 'erro desconhecido' }
    });
  } catch (err) {
    logger.warn(`[WebhookEvent] Falha ao marcar resultado: ${err.message}`);
  }
}

module.exports = { eventKeyFor, begin, finish };
