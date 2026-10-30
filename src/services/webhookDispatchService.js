'use strict';

/**
 * Entrega de webhooks aos sistemas dos utilizadores (subscrições em /api/webhooks).
 *
 * - Eventos: ORDER_STATUS_CHANGED, COMMISSION_PAID, PREMIUM_ACTIVATED (vêm do eventBus).
 * - Cada entrega fica gravada em WebhookDelivery (PENDENTE → ENTREGUE | FALHADA).
 * - Assinatura: cabeçalho `X-Bazares-Signature: t=<unix>,v1=<hmac>` onde
 *   hmac = HMAC-SHA256(secret, `${t}.${corpo}`) — o receptor recalcula e compara.
 * - Anti-SSRF: o DNS é validado NO MOMENTO DA LIGAÇÃO (opção `lookup` do https), recusa IPs
 *   privados/loopback/link-local, não segue redirects e limita o tempo e o tamanho da resposta.
 * - Reenvios: até MAX_ATTEMPTS tentativas com espera crescente, repetidas por um job (sem
 *   precisar de campos novos no schema — usa createdAt + nº de tentativas).
 * Nunca lança para quem emite: uma falha aqui não afecta o pedido original.
 */
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const https = require('https');

// require preguiçoso: facilita testar as funções puras sem BD/logger.
const prisma = () => require('../config/database');
const log = () => require('../utils/logger');

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [0, 1, 5, 30, 120]; // minutos desde a criação, por nº de tentativas já feitas
const TIMEOUT_MS = 8000;
const RETENTION_DAYS = 30;

// ─── Funções puras ─────────────────────────────────────────────────
function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 mapeado
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // não é IP válido → recusa
}

const isDue = (delivery, now = Date.now()) => {
  const wait = BACKOFF_MIN[Math.min(delivery.attempts, BACKOFF_MIN.length - 1)] * 60 * 1000;
  return now - new Date(delivery.createdAt).getTime() >= wait;
};

// DNS validado ao ligar (protege contra DNS rebinding).
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return cb(new Error('Destino não permitido (IP privado/interno).'));
    }
    if (options && options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function post(url, body, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'URL inválido' }); }
    const req = https.request({
      method: 'POST', hostname: u.hostname, port: 443, path: u.pathname + u.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: safeLookup, timeout: TIMEOUT_MS
    }, (res) => {
      res.resume(); // descarta a resposta (não precisamos dela)
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300; // 3xx NÃO é seguido
        resolve({ ok, httpStatus: res.statusCode, error: ok ? null : `HTTP ${res.statusCode}` });
      });
      res.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

// ─── Entrega de uma WebhookDelivery ────────────────────────────────
async function attempt(delivery, subscription) {
  const db = prisma();
  // Claim atómico: só UM processo/tentativa avança (contra o job e o envio imediato em paralelo).
  const claim = await db.webhookDelivery.updateMany({
    where: { id: delivery.id, status: 'PENDENTE', attempts: delivery.attempts },
    data: { attempts: { increment: 1 } }
  });
  if (claim.count === 0) return;

  const body = JSON.stringify({ id: delivery.id, event: delivery.event, createdAt: delivery.createdAt, data: delivery.payload });
  const t = Math.floor(Date.now() / 1000);
  const r = await post(subscription.url, body, {
    'Content-Type': 'application/json',
    'User-Agent': 'Bazares-Webhooks/1.0',
    'X-Bazares-Event': delivery.event,
    'X-Bazares-Delivery': delivery.id,
    'X-Bazares-Signature': `t=${t},v1=${sign(subscription.secret, t, body)}`
  });

  const attemptsNow = delivery.attempts + 1;
  const data = r.ok
    ? { status: 'ENTREGUE', httpStatus: r.httpStatus, deliveredAt: new Date(), lastError: null }
    : { status: attemptsNow >= MAX_ATTEMPTS ? 'FALHADA' : 'PENDENTE', httpStatus: r.httpStatus || null, lastError: String(r.error || 'erro').slice(0, 300) };
  await db.webhookDelivery.update({ where: { id: delivery.id }, data });
}

// ─── Criar entregas para um evento ─────────────────────────────────
async function dispatch(event, userIds, data) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    const db = prisma();
    const subs = await db.webhookSubscription.findMany({
      where: { userId: { in: ids }, active: true, events: { has: event } }
    });
    for (const sub of subs) {
      const delivery = await db.webhookDelivery.create({
        data: { subscriptionId: sub.id, event, payload: data || {} }
      });
      attempt(delivery, sub).catch((e) => log().warn(`[Webhooks] entrega ${delivery.id}: ${e.message}`));
    }
  } catch (e) {
    log().warn(`[Webhooks] dispatch ${event} falhou: ${e.message}`);
  }
}

// ─── Ping de teste (o utilizador valida o URL/assinatura sem esperar por um evento real) ───
async function sendTest(subscription) {
  const db = prisma();
  const delivery = await db.webhookDelivery.create({
    data: { subscriptionId: subscription.id, event: subscription.events[0], payload: { test: true, message: 'Ping de teste do Bazares' } }
  });
  await attempt(delivery, subscription);
  const done = await db.webhookDelivery.findUnique({ where: { id: delivery.id }, select: { status: true, httpStatus: true, lastError: true } });
  return done;
}

// ─── Job de reenvio + limpeza ──────────────────────────────────────
async function runRetryJob() {
  const db = prisma();
  const pending = await db.webhookDelivery.findMany({
    where: { status: 'PENDENTE', attempts: { gt: 0, lt: MAX_ATTEMPTS } },
    include: { subscription: true }, orderBy: { createdAt: 'asc' }, take: 100
  });
  for (const d of pending) {
    if (!isDue(d)) continue;
    if (!d.subscription || !d.subscription.active) {
      await db.webhookDelivery.update({ where: { id: d.id }, data: { status: 'FALHADA', lastError: 'Subscrição inactiva ou removida.' } }).catch(() => {});
      continue;
    }
    await attempt(d, d.subscription).catch((e) => log().warn(`[Webhooks] reenvio ${d.id}: ${e.message}`));
  }
  // Tentativas que ficaram a meio (processo reiniciado antes de gravar o resultado) → voltam a ser elegíveis.
  await db.webhookDelivery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86400 * 1000) } } });
}

function init() {
  const bus = require('./eventBus');
  bus.on(bus.EVENTS.ORDER_STATUS_CHANGED, ({ orderId, buyerId, sellerId, status, from }) =>
    dispatch('ORDER_STATUS_CHANGED', [buyerId, sellerId], { orderId, status, from }));
  bus.on(bus.EVENTS.COMMISSION_PAID, ({ sellerId, bazarId, amount, method }) =>
    dispatch('COMMISSION_PAID', [sellerId], { bazarId, amount, method }));
  bus.on(bus.EVENTS.PREMIUM_ACTIVATED, ({ userId, expiresAt }) =>
    dispatch('PREMIUM_ACTIVATED', [userId], { userId, expiresAt }));

  const safe = require('../utils/noOverlap').noOverlap(async () => { try { await runRetryJob(); } catch (e) { log().error(`[Webhooks] job: ${e.message}`); } });
  const timers = [setTimeout(safe, 60 * 1000), setInterval(safe, 2 * 60 * 1000)];
  timers.forEach((t) => t.unref && t.unref());
  return timers;
}

module.exports = { init, dispatch, sendTest, runRetryJob, sign, isPrivateIp, isDue, MAX_ATTEMPTS };
