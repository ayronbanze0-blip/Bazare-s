'use strict';

/**
 * Cache em memória com TTL — abstração mínima (sem Redis, de propósito).
 *
 * Serve para agregações caras e pouco sensíveis a segundos de atraso (dashboards, estatísticas
 * públicas, categorias). Por instância: se um dia houver várias instâncias, esta é a única
 * interface a trocar por Redis (get/set/wrap/delete) — os chamadores não mudam.
 */
function createTtlCache({ ttlMs = 60000, max = 500, now = Date.now } = {}) {
  const store = new Map(); // key -> { value, expiresAt }

  const get = (key) => {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now()) { store.delete(key); return undefined; }
    return e.value;
  };

  const set = (key, value, ttl = ttlMs) => {
    if (store.size >= max) {
      // remove expirados; se ainda cheio, remove o mais antigo (ordem de inserção do Map)
      for (const [k, e] of store) if (e.expiresAt <= now()) store.delete(k);
      if (store.size >= max) store.delete(store.keys().next().value);
    }
    store.set(key, { value, expiresAt: now() + ttl });
    return value;
  };

  /** Devolve o valor em cache ou calcula (uma vez) e guarda. Erros NÃO ficam em cache. */
  const wrap = async (key, fn, ttl = ttlMs) => {
    const hit = get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    return set(key, value, ttl);
  };

  return { get, set, wrap, delete: (key) => store.delete(key), clear: () => store.clear(), size: () => store.size };
}

module.exports = { createTtlCache };
