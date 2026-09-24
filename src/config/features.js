'use strict';

/**
 * Feature flags por variável de ambiente (kill switches). Sem dependências.
 *
 * Todas as funcionalidades estão LIGADAS por omissão. Para desligar uma sem apagar código nem
 * fazer deploy de código novo, define no Render (e reinicia): ENABLE_AI=false, ENABLE_REELS=false…
 * Valores que desligam: false, 0, off, no. Qualquer outro valor (ou ausente) = ligado.
 *
 * Além disto, cada flag pode ser desligada em tempo real pelo painel admin
 * (PUT /api/admin/feature-flags/enable_ai { "enabled": false }) — ver middleware/featureGate.js.
 */

const KNOWN = ['ENABLE_AI', 'ENABLE_PAYMENTS', 'ENABLE_PREMIUM', 'ENABLE_REELS', 'ENABLE_COMMUNITIES', 'ENABLE_SOCIAL_FEED'];
const OFF = new Set(['false', '0', 'off', 'no']);

function envEnabled(name, env = process.env) {
  const v = env[name];
  if (v === undefined || v === null) return true;
  return !OFF.has(String(v).trim().toLowerCase());
}

/** Estado de todas as flags conhecidas (para diagnóstico). */
function envSnapshot(env = process.env) {
  return Object.fromEntries(KNOWN.map((k) => [k, envEnabled(k, env)]));
}

module.exports = { KNOWN, envEnabled, envSnapshot };
