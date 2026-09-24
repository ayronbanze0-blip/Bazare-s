'use strict';

const { ok, badRequest, serverError } = require('../utils/response');
const { listFlags, setFlag } = require('../services/featureFlags');
const audit = require('../services/auditService');
const logger = require('../utils/logger');

// GET /api/admin/feature-flags — lista todas as flags conhecidas.
async function index(req, res) {
  try {
    const flags = await listFlags();
    return ok(res, { flags });
  } catch (err) {
    logger.error(`[featureFlags.index] ${err.message}`);
    return serverError(res);
  }
}

// PUT /api/admin/feature-flags/:key  { enabled: boolean, description?: string }
// (Express 4 não apanha rejeições de handlers async — por isso o try/catch:
// antes, um erro de BD aqui deixava o pedido pendurado até ao timeout.)
async function update(req, res) {
  try {
    const { key } = req.params;
    const { enabled, description } = req.body || {};

    if (typeof enabled !== 'boolean') {
      // Antes: validationError(res, { enabled: '...' }) — recebia um objecto em vez
      // de um array e rebentava com TypeError (pedido pendurado).
      return badRequest(res, 'enabled deve ser true ou false.');
    }
    if (!key || !/^[a-z0-9_]+$/.test(key)) {
      return badRequest(res, 'Chave de flag inválida (usar apenas a-z, 0-9, _).');
    }

    const flag = await setFlag(key, enabled, { description, updatedBy: req.user?.id });
    audit.record(req, 'ADMIN_FEATURE_FLAG_CHANGE', { entity: 'FeatureFlag', entityId: key, newValue: { enabled } });
    logger.info(`[featureFlags] "${key}" -> ${enabled} (por ${req.user?.id || 'desconhecido'})`);
    return ok(res, { flag });
  } catch (err) {
    logger.error(`[featureFlags.update] ${err.message}`);
    return serverError(res);
  }
}

module.exports = { index, update };
