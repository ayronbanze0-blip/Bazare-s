'use strict';

const rateLimit = require('express-rate-limit');
const { tooMany } = require('../utils/response');

const makeHandler = (message) => (req, res) => tooMany(res, message);

// Nota: o 'apiLimiter' é montado em app.js ANTES do router (app.use('/api',
// apiLimiter) vem antes de app.use('/api', routes)), ou seja, corre antes do
// middleware 'authenticate' de cada rota — req.user ainda não existe aqui,
// por isso este limiter tem de continuar a contar por IP. O keyByUserOrIp
// só faz sentido em limiters aplicados DEPOIS de 'authenticate' na própria
// rota (ex: orderLimiter abaixo), onde req.user já está definido.
const keyByUserOrIp = (req) => req.user?.id || req.ip;

// ─── General API limiter (por IP — ver nota acima) ────────────────
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Demasiados pedidos. Tente novamente mais tarde.')
});

// ─── Order limiter (mais generoso — picos legítimos de concorrência) ──
const orderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: parseInt(process.env.ORDER_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  handler: makeHandler('Demasiadas encomendas em pouco tempo. Aguarde um momento.')
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

// ─── AI limiter (Gemini) ──────────────────────────────────────────
// Chamadas a modelos de IA custam dinheiro real por pedido — muito
// mais caro que um pedido normal à API. O limiter geral (apiLimiter,
// 300/15min) é generoso demais para isto: um utilizador (ou bot)
// podia gerar centenas de chamadas caras ao Gemini por pouco mais que
// tráfego normal de API. Usado na pesquisa inteligente e no BazarBot.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  handler: makeHandler('Demasiados pedidos à IA em pouco tempo. Aguarde um minuto.')
});

// ─── Códigos de 6 dígitos (reset de password / verificação de email) ─
// Um código de 6 dígitos tem só 1.000.000 de combinações. O authLimiter conta
// por IP — um atacante com muitos IPs contornava-o. Este conta por EMAIL alvo,
// independentemente do IP: no máximo 8 tentativas falhadas por 15 min.
// (`skipSuccessfulRequests`: o utilizador legítimo que acerta não é penalizado.)
const emailFromBody = (req) => String(req.body?.email || '').toLowerCase().trim();
const codeAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `code:${emailFromBody(req) || req.ip}`,
  handler: makeHandler('Demasiadas tentativas com este código. Aguarde 15 minutos e peça um novo código.')
});

// ─── Envio de emails por destinatário ────────────────────────────────
// O emailLimiter conta por IP; isto impede "email bombing" de UMA vítima
// a partir de muitos IPs: no máximo 3 pedidos por hora para o mesmo email.
const emailTargetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mail:${emailFromBody(req) || req.ip}`,
  // Mesma resposta genérica que o sucesso — não revela nada sobre o email.
  handler: (req, res) => res.status(200).json({ success: true, message: 'Se o email existir, receberá um código em breve.', data: {} })
});

// ─── Webhooks (por IP) ──────────────────────────────────────────────
// Generoso (o gateway pode reenviar em rajada) mas impede inundação de
// pedidos não assinados a gastar CPU em HMAC.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Demasiados pedidos de webhook.')
});

// ─── Acções administrativas (por utilizador) ────────────────────────
// Depois de `authenticate`, conta por admin. Alto o suficiente para uso
// normal do painel, baixo o suficiente para travar um token admin roubado
// ou um script em ciclo (broadcast, delete, etc.).
const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.ADMIN_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  handler: makeHandler('Demasiadas acções administrativas. Aguarde um momento.')
});

// ─── Interacções sem autenticação que alteram contadores ────────────
// (visualizações de produto, cliques de WhatsApp) — impede inflar métricas em ciclo.
const publicTrackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(204).end() // fire-and-forget: o frontend não precisa de erro
});

module.exports = {
  apiLimiter, authLimiter, uploadLimiter, emailLimiter, orderLimiter, aiLimiter,
  codeAttemptLimiter, emailTargetLimiter, webhookLimiter, adminActionLimiter, publicTrackLimiter
};
