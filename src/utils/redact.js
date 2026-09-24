'use strict';

/**
 * Redacção de dados sensíveis — UMA única implementação, usada em:
 *   - logger (winston)          → nunca escrever passwords/tokens em log
 *   - Sentry (beforeSend)       → nunca enviar passwords/tokens ao Sentry
 *   - respostas JSON (app.js)   → rede de segurança: `passwordHash` nunca sai da API
 *
 * Sem dependências externas de propósito (testável com `node` puro).
 */

const REDACTED = '[REDACTED]';

// Nomes de campos (comparação case-insensitive, sem "_" nem "-") cujo valor
// nunca deve aparecer em logs / Sentry.
const SENSITIVE_KEYS = new Set([
  'password', 'newpassword', 'currentpassword', 'oldpassword', 'passwordhash',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'cookie', 'setcookie',
  'secret', 'apikey', 'apisecret', 'clientsecret', 'webhooksecret',
  'code', 'otp', 'pin',
  'cardnumber', 'cvv', 'msisdn',
  'jwt', 'xzumbopaysignature'
]);

// Campos que NUNCA devem sair numa resposta da API (rede de segurança).
// Propositadamente curto: `refreshToken`/`accessToken` são legítimos no login.
const NEVER_IN_RESPONSE = new Set(['passwordhash']);

const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Devolve uma cópia profunda de `value` com os campos sensíveis substituídos.
 * Protege contra ciclos e limita a profundidade.
 */
function redact(value, { maxDepth = 6 } = {}) {
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    if (depth > maxDepth) return '[Truncated]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Date) return v;
    if (Buffer.isBuffer(v)) return '[Buffer]';
    if (!isPlainObject(v)) return v; // Error, Map, classes… não mexer
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEYS.has(normKey(k)) ? REDACTED : walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * Remove (não substitui) os campos que nunca podem sair numa resposta HTTP.
 * Muta a estrutura recebida — pensada para o payload que já vai ser
 * serializado. Ignora Date/Buffer e limita a profundidade.
 */
function stripForResponse(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stripForResponse(item, depth + 1, seen);
    return value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  for (const k of Object.keys(value)) {
    if (NEVER_IN_RESPONSE.has(normKey(k))) delete value[k];
    else stripForResponse(value[k], depth + 1, seen);
  }
  return value;
}

/** Mascara um número de telefone: 258841234567 → 25884*****67 */
function maskMsisdn(raw) {
  const s = String(raw || '').replace(/\D/g, '');
  if (s.length < 7) return '***';
  return `${s.slice(0, 5)}${'*'.repeat(s.length - 7)}${s.slice(-2)}`;
}

module.exports = { redact, stripForResponse, maskMsisdn, REDACTED, SENSITIVE_KEYS };
