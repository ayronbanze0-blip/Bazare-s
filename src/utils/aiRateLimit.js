'use strict';

// ─────────────────────────────────────────────────────────────────
// express-rate-limit (usado em rateLimiter.js) só cobre pedidos HTTP.
// O BazarBot também é accionado a partir do Socket.IO (chatSocket.js
// message:send), que não passa por nenhum middleware Express — sem
// isto, não havia NENHUM limite específico às chamadas de IA feitas
// por essa via (só o limite genérico de mensagens, que é barato
// comparado com uma chamada ao Gemini).
//
// Janela deslizante simples em memória, por userId. Suficiente para
// uma instância única (Render free/starter); se o processo escalar
// para múltiplas instâncias, isto passa a ser por-instância em vez de
// global — nesse caso substituir por um contador em Redis.
// ─────────────────────────────────────────────────────────────────

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = parseInt(process.env.AI_RATE_LIMIT_MAX) || 10;

const hits = new Map(); // userId -> [timestamps]

const checkAiLimit = (userId) => {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(userId, arr);
    return false;
  }
  arr.push(now);
  hits.set(userId, arr);
  return true;
};

// Limpeza periódica para não acumular entradas de utilizadores inactivos.
setInterval(() => {
  const now = Date.now();
  for (const [userId, arr] of hits.entries()) {
    const fresh = arr.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) hits.delete(userId);
    else hits.set(userId, fresh);
  }
}, 5 * 60 * 1000).unref();

module.exports = { checkAiLimit };
