'use strict';

/**
 * Cache curta (em memória) das listagens PÚBLICAS para visitantes SEM sessão.
 *
 * Porquê: no lançamento, centenas de pessoas abrem o catálogo/destaques/ranking quase ao mesmo tempo e
 * cada pedido igual ia à base de dados. Com esta cache, o mesmo URL é calculado 1 vez a cada TTL
 * (por omissão 20 s) e as restantes respostas saem da memória — a BD (o primeiro limite do sistema) respira.
 *
 * Regras de segurança:
 *  - só GET e só pedidos SEM cabeçalho Authorization (quem tem sessão vê dados pessoais: favoritos, seguir…);
 *  - só respostas 200 com JSON; nunca guarda erros;
 *  - a chave é o URL completo (inclui query: pesquisa, filtros, página);
 *  - respostas muito grandes não são guardadas.
 * Só deve ser usada em rotas cuja resposta, para um anónimo, NÃO depende de quem pergunta.
 */
const { createTtlCache } = require('../utils/ttlCache');

function publicCache({ ttlMs = 20 * 1000, max = 300, maxBytes = 256 * 1024 } = {}) {
  const cache = createTtlCache({ ttlMs, max });
  const maxAge = Math.max(1, Math.floor(ttlMs / 2000)); // o browser/telemóvel reutiliza metade do TTL

  return function publicCacheMiddleware(req, res, next) {
    if (req.method !== 'GET' || req.headers.authorization) return next();
    const key = req.originalUrl;
    res.setHeader('Vary', 'Authorization');

    const hit = cache.get(key);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      return res.status(200).type('application/json').send(hit);
    }

    res.setHeader('X-Cache', 'MISS');
    const origSend = res.send;
    res.send = function patchedSend(body) {
      res.send = origSend; // só intercepta uma vez
      const ct = String(res.getHeader('Content-Type') || '');
      if (res.statusCode === 200 && typeof body === 'string' && ct.includes('json') && body.length <= maxBytes) {
        cache.set(key, body);
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      }
      return origSend.call(this, body);
    };
    return next();
  };
}

module.exports = { publicCache };
