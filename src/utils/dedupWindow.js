'use strict';

// ─────────────────────────────────────────────────────────────────
// Contadores públicos e sem autenticação (visualizações de produto,
// cliques no WhatsApp) são triviais de inflacionar com um bot a repetir
// o mesmo pedido milhares de vezes. Isto não substitui uma solução
// real (analytics com deduplicação adequada, Redis, etc.), mas evita
// o caso mais óbvio: o MESMO (chave, alvo) a contar repetidamente
// dentro de uma janela curta.
//
// Em memória, por instância — reinicia ao reiniciar o processo e não
// é partilhado entre instâncias, mas é suficiente para o volume actual
// do Bazares e não tem custo de infraestrutura nova.
// ─────────────────────────────────────────────────────────────────

const seen = new Map(); // `${namespace}:${key}:${targetId}` -> timestamp

const shouldCount = (namespace, key, targetId, windowMs) => {
  const dedupKey = `${namespace}:${key}:${targetId}`;
  const now = Date.now();
  const last = seen.get(dedupKey);
  if (last && now - last < windowMs) return false;
  seen.set(dedupKey, now);
  return true;
};

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, t] of seen.entries()) {
    if (t < cutoff) seen.delete(k);
  }
}, 60 * 60 * 1000).unref();

module.exports = { shouldCount };
