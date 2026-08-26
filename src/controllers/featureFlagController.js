'use strict';

const { ok, badRequest, validationError } = require('../utils/response');
const { listFlags, setFlag } = require('../services/featureFlags');
const logger = require('../utils/logger');

// GET /api/admin/feature-flags — lista todas as flags conhecidas.
async function index(req, res) {
  const flags = await listFlags();
  return ok(res, { flags });
}

// PUT /api/admin/feature-flags/:key  { enabled: boolean, description?: string }
async function update(req, res) {
  const { key } = req.params;
  const { enabled, description } = req.body || {};

  if (typeof enabled !== 'boolean') {
    return validationError(res, { enabled: 'enabled deve ser true ou false' });
  }
  if (!key || !/^[a-z0-9_]+$/.test(key)) {
    return badRequest(res, 'Chave de flag inválida (usar apenas a-z, 0-9, _).');
  }

  const flag = await setFlag(key, enabled, { description, updatedBy: req.user?.id });
  logger.info(`[featureFlags] "${key}" -> ${enabled} (por ${req.user?.id || 'desconhecido'})`);
  return ok(res, { flag });
}

module.exports = { index, update };
