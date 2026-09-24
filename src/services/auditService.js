'use strict';

/**
 * Auditoria — ÚNICO ponto de escrita no modelo AuditLog para acções sensíveis
 * (o middleware `audit()` existente e o REGISTER do authController usam o mesmo modelo).
 *
 * Regras:
 *  - Fire-and-forget: nunca atrasa nem faz falhar o pedido de quem chama.
 *  - Nunca guarda passwords/tokens/segredos (tudo passa por `redact`).
 *  - Guarda o requestId (o mesmo do header X-Request-Id, dos logs e do Sentry)
 *    dentro de `newValue.requestId` — não exige alteração de schema.
 *  - Registos financeiros e de auditoria nunca são apagados por código.
 */

const prisma = require('../config/database');
const logger = require('../utils/logger');
const { redact } = require('../utils/redact');

const clip = (v, n = 255) => (typeof v === 'string' ? v.slice(0, n) : null);

/**
 * @param {object|null} req  pedido Express (pode ser null em jobs/webhooks)
 * @param {string} action    ex.: 'ADMIN_USER_SUSPEND'
 * @param {object} [opts]    { entity, entityId, oldValue, newValue, userId }
 * @returns {Promise<object|null>} resolve sempre (nunca rejeita)
 */
const record = (req, action, { entity = null, entityId = null, oldValue = null, newValue = null, userId } = {}) => {
  const requestId = req && req.id ? req.id : null;
  const payload = newValue || requestId ? { ...(newValue || {}), ...(requestId && { requestId }) } : null;

  return Promise.resolve()
    .then(() => prisma.auditLog.create({
      data: {
        userId: userId !== undefined ? userId : (req && req.user ? req.user.id : null),
        action,
        entity,
        entityId: entityId ? String(entityId) : null,
        oldValue: oldValue ? redact(oldValue) : undefined,
        newValue: payload ? redact(payload) : undefined,
        ipAddress: req ? req.ip : null,
        userAgent: req && req.headers ? clip(req.headers['user-agent']) : null
      }
    }))
    .catch((err) => {
      logger.warn(`[Audit] Falha ao registar ${action}: ${err.message}`);
      return null;
    });
};

module.exports = { record };
