'use strict';

/**
 * FEATURE FLAGS — desativar funcionalidades sem novo deploy
 * ============================================================
 * Antes desta ronda não existia nenhum mecanismo de feature flag: a
 * única forma de "desligar" algo era reverter código e fazer deploy.
 *
 * Guarda o estado na tabela FeatureFlag (Postgres) e mantém uma cache
 * em memória de CACHE_TTL_MS para não bater na BD em cada pedido —
 * um toggle feito no admin demora no máximo esse tempo a propagar-se
 * a todos os processos.
 *
 * Uso típico num controller:
 *   const { isEnabled } = require('../services/featureFlags');
 *   if (!(await isEnabled('analytics_dashboard'))) {
 *     return res.status(404).json({ error: 'not_found' });
 *   }
 */

const prisma = require('../config/database');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 30_000;
let _cache = new Map(); // key -> { enabled, expiresAt }

async function isEnabled(key, defaultValue = false) {
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;

  try {
    const flag = await prisma.featureFlag.findUnique({ where: { key } });
    const enabled = flag ? flag.enabled : defaultValue;
    _cache.set(key, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
    return enabled;
  } catch (err) {
    // Se a BD estiver em baixo, falha para o valor por omissão em vez
    // de rebentar a funcionalidade que depende da flag.
    logger.error(`[featureFlags] falha a ler "${key}": ${err.message}`);
    return defaultValue;
  }
}

async function setFlag(key, enabled, { description, updatedBy } = {}) {
  const flag = await prisma.featureFlag.upsert({
    where: { key },
    update: { enabled, ...(description !== undefined && { description }), updatedBy },
    create: { key, enabled, description, updatedBy },
  });
  _cache.set(key, { enabled: flag.enabled, expiresAt: Date.now() + CACHE_TTL_MS });
  return flag;
}

async function listFlags() {
  return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

// Só para testes — evita que o estado de um teste contamine o seguinte.
function _clearCache() {
  _cache.clear();
}

module.exports = { isEnabled, setFlag, listFlags, _clearCache };
