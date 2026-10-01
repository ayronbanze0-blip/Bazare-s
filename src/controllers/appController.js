'use strict';

/**
 * Camada de configuração/permissões — o backend diz ao frontend o que mostrar.
 *   GET /api/app/config     (público)  flags + limites
 *   GET /api/me/permissions (auth)     o que este utilizador pode fazer
 * A segurança real continua nas rotas; isto serve só para adaptar a interface.
 */

const { ok, badRequest, serverError } = require('../utils/response');
const crypto = require('crypto');
const eventBus = require('../services/eventBus');
const { envEnabled } = require('../config/features');
const { isEnabled } = require('../services/featureFlags');
const logger = require('../utils/logger');

// flag pública -> variável/flag interna (mesmos nomes usados em requireFeature)
const PUBLIC_FLAGS = {
  reels: 'ENABLE_REELS',
  feed: 'ENABLE_SOCIAL_FEED',
  communities: 'ENABLE_COMMUNITIES',
  premium: 'ENABLE_PREMIUM',
  payments: 'ENABLE_PAYMENTS',
  ai: 'ENABLE_AI'
};

const config = async (req, res) => {
  try {
    const entries = await Promise.all(Object.entries(PUBLIC_FLAGS).map(async ([pub, name]) => {
      if (!envEnabled(name)) return [pub, false];
      return [pub, await isEnabled(name.toLowerCase(), true)];
    }));
    res.set('Cache-Control', 'public, max-age=30');
    return ok(res, {
      features: Object.fromEntries(entries),
      limits: { maxImages: 20 }
    });
  } catch (err) {
    logger.error(`[App.config] ${err.message}`);
    return serverError(res);
  }
};

const permissions = async (req, res) => {
  const role = req.user && req.user.role;
  const isAdmin = role === 'ADMIN';
  const isSeller = role === 'SELLER' || isAdmin;
  const isReseller = role === 'REVENDEDOR';
  return ok(res, {
    role,
    canBuy: true,
    canSell: isSeller,
    canManageProducts: isSeller,
    canCreateReels: true,
    canResell: isReseller || isAdmin,
    canManageUsers: isAdmin,
    canAccessAdmin: isAdmin
  });
};

// ─── GET /api/app/bootstrap ───────────────────────────────────────
// O frontend (Bazares.Backend, core.js) pede isto ao arrancar com sessão; se vier um manifesto, liga
// o canal `app:command`. Sem `navigation` de propósito: o menu continua a ser o do frontend (se vier
// `navigation`, o frontend passa a construir o menu a partir dele). `events` vazio de propósito:
// order:updated / stock:updated / product:updated já são tratados pelas próprias páginas
// (my-orders, order-detail, my-products) — mapeá-los aqui duplicaria o refresh.
const bootstrap = (req, res) => {
  res.set('Cache-Control', 'no-store');
  return ok(res, { version: 1, serverTime: new Date().toISOString(), events: {} });
};

// ─── POST /api/admin/app/command ──────────────────────────────────
// body: { type, payload?, userId? }  (sem userId = todos os utilizadores ligados)
// Tipos que o frontend executa (runCommand em core.js): invalidate, toast, navigate, refresh, maintenance, logout.
const COMMAND_TYPES = ['invalidate', 'toast', 'navigate', 'refresh', 'maintenance', 'logout'];
const TOAST_KINDS = ['ok', 'warn', 'err', 'info'];

// Valida e normaliza. Devolve { command } ou { error }. Pura (sem I/O) para ser testável.
const buildCommand = (body = {}) => {
  const type = body.type;
  if (!COMMAND_TYPES.includes(type)) return { error: `type inválido. Use: ${COMMAND_TYPES.join(', ')}.` };
  const raw = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
  const payload = {};
  if (type === 'invalidate') {
    const keys = Array.isArray(raw.keys) ? raw.keys : ['*'];
    payload.keys = keys.filter((k) => typeof k === 'string' && k.length <= 60).slice(0, 20);
    if (!payload.keys.length) payload.keys = ['*'];
  }
  if (type === 'toast' || type === 'maintenance') {
    const msg = typeof raw.message === 'string' ? raw.message.trim().slice(0, 200) : '';
    if (type === 'toast' && !msg) return { error: 'toast exige payload.message.' };
    if (msg) payload.message = msg;
    if (type === 'toast') payload.kind = TOAST_KINDS.includes(raw.kind) ? raw.kind : 'ok';
  }
  if (type === 'navigate') {
    if (typeof raw.to !== 'string' || !/^[a-z0-9-]+\.html$/i.test(raw.to)) return { error: 'navigate exige payload.to com o nome de uma página (ex.: "home.html").' };
    payload.to = raw.to;
  }
  return { command: { id: crypto.randomUUID(), type, payload, at: new Date().toISOString() } };
};

const sendCommand = (req, res) => {
  try {
    const { command, error } = buildCommand(req.body);
    if (error) return badRequest(res, error);
    const userId = typeof req.body.userId === 'string' && req.body.userId ? req.body.userId : null;
    eventBus.emit(eventBus.EVENTS.APP_COMMAND, { command, userId });
    logger.info(`[App.command] ${command.type} → ${userId || 'todos'} por admin ${req.user && req.user.id}`);
    return ok(res, { command, target: userId || 'all' }, 'Comando enviado.');
  } catch (err) {
    logger.error(`[App.sendCommand] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { config, permissions, bootstrap, sendCommand, buildCommand };
