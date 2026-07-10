'use strict';

const logger = require('../utils/logger');

let prismaClient;
const init = (prisma) => { prismaClient = prisma; };

const audit = (action, entity = null) => (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    // Responde ao cliente IMEDIATAMENTE — o log de auditoria é só um
    // registo interno, não deve atrasar quem está à espera da resposta.
    // Sob muitos pedidos simultâneos, esperar por uma escrita extra na
    // BD antes de responder significa segurar a ligação HTTP mais tempo
    // exactamente quando o pool de ligações já está sob pressão.
    const result = originalJson(data);

    if (data?.success && prismaClient && req.user) {
      prismaClient.auditLog.create({
        data: {
          userId: req.user.id,
          action,
          entity,
          entityId: req.params?.id || data?.data?.id || null,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']?.slice(0, 255)
        }
      }).catch((e) => {
        logger.warn(`[Audit] Failed to log: ${e.message}`);
      });
    }

    return result;
  };
  next();
};

module.exports = { init, audit };
