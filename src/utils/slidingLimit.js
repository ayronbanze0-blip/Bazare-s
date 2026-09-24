'use strict';

/**
 * Limitador de janela deslizante em memória (por instância de socket).
 * Usado para travar inundação de eventos Socket.IO (que não passam pelo
 * express-rate-limit). Sem dependências — testável com `node` puro.
 *
 *   const allow = createLimiter({ max: 20, windowMs: 10_000 });
 *   if (!allow()) return socket.emit('error', ...);
 */
function createLimiter({ max, windowMs, now = Date.now }) {
  let hits = [];
  return function allow() {
    const t = now();
    hits = hits.filter((h) => t - h < windowMs);
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}

module.exports = { createLimiter };
