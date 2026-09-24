'use strict';

const { randomUUID } = require('crypto');

// ─── Request ID ────────────────────────────────────────────────────
// Atribui um ID a cada pedido HTTP. Isto permite:
//  - Encontrar todas as linhas de log de UM pedido específico (útil
//    quando um cliente reporta "dei erro às 14:32" e há centenas de
//    linhas de log por segundo em produção).
//  - Devolver esse ID ao cliente (header X-Request-Id, e `requestId` nas
//    respostas de erro) para que, ao contactar o suporte, baste copiar o ID.
//  - Correlacionar o mesmo pedido no Sentry (tag `requestId`) e no AuditLog.
//
// Um X-Request-Id vindo do cliente/proxy só é aceite se tiver formato seguro
// (evita "log injection" e IDs gigantes); caso contrário geramos um novo.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  try {
    // require lazy: mantém este middleware testável sem o SDK do Sentry instalado.
    require('../config/sentry').setTag('requestId', req.id);
  } catch { /* Sentry indisponível (ex.: testes) — ignorar */ }
  next();
};

requestId.SAFE_ID = SAFE_ID;
module.exports = requestId;
