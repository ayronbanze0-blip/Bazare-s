'use strict';

const { randomUUID } = require('crypto');

// ─── Request ID ────────────────────────────────────────────────────
// Atribui um ID curto a cada pedido HTTP. Isto permite:
//  - Encontrar todas as linhas de log de UM pedido específico (útil
//    quando um cliente reporta "dei erro às 14:32" e há centenas de
//    linhas de log por segundo em produção).
//  - Devolver esse ID ao cliente (header X-Request-Id) para que, ao
//    contactar o suporte, baste copiar o ID em vez de descrever o erro.
const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestId;
