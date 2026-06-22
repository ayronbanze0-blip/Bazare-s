'use strict';

const logger = require('../utils/logger');

let prismaClient;
const init = (prisma) => { prismaClient = prisma; };

const audit = (action, entity = null) => async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = async function (data) {
    if (data?.success && prismaClient && req.user) {
      try {
        await prismaClient.auditLog.create({
          data: {
            userId: req.user.id,
            action,
            entity,
            entityId: req.params?.id || data?.data?.id || null,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']?.slice(0, 255)
          }
        });
      } catch (e) {
        logger.warn(`[Audit] Failed to log: ${e.message}`);
      }
    }
    return originalJson(data);
  };
  next();
};

module.exports = { init, audit };
