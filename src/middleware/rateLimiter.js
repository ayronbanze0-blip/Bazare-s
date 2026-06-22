'use strict';

const rateLimit = require('express-rate-limit');
const { tooMany } = require('../utils/response');

const makeHandler = (message) => (req, res) => tooMany(res, message);

// ─── General API limiter ─────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Demasiados pedidos. Tente novamente mais tarde.')
});

// ─── Auth limiter (stricter) ─────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: makeHandler('Demasiadas tentativas de autenticação. Aguarde 15 minutos.')
});

// ─── Upload limiter ──────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  handler: makeHandler('Limite de uploads atingido. Tente novamente em 1 hora.')
});

// ─── Email limiter ───────────────────────────────────────────────
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: makeHandler('Demasiados emails enviados. Aguarde 1 hora.')
});

module.exports = { apiLimiter, authLimiter, uploadLimiter, emailLimiter };
