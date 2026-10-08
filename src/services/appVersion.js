'use strict';

/**
 * Verificação de versão da app (actualização opcional / obrigatória) — lógica PURA.
 * Configuração por env (alterável no Render sem novo deploy de código):
 *   APP_LATEST_VERSION_ANDROID / _IOS   última versão publicada (ex.: 1.4.0)
 *   APP_MIN_VERSION_ANDROID    / _IOS   versão mínima suportada — abaixo disto a actualização é OBRIGATÓRIA
 *   APP_STORE_URL_ANDROID      / _IOS   ligação da loja
 *   APP_UPDATE_MESSAGE                  mensagem opcional
 */
const PLATFORMS = ['android', 'ios', 'web'];

/** "1.4.0" → [1,4,0]; devolve null se não for uma versão válida (a-b-c numérico, até 4 partes). */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?(?:[-+].*)?$/);
  if (!m) return null;
  return [1, 2, 3, 4].map((i) => (m[i] === undefined ? 0 : Number(m[i])));
}

/** -1 | 0 | 1 (null se alguma não for válida). */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function check({ platform, version }, env = process.env) {
  const p = PLATFORMS.includes(String(platform).toLowerCase()) ? String(platform).toLowerCase() : null;
  const key = p ? p.toUpperCase() : null;
  const latest = key ? env[`APP_LATEST_VERSION_${key}`] || null : null;
  const min = key ? env[`APP_MIN_VERSION_${key}`] || null : null;
  const storeUrl = key ? env[`APP_STORE_URL_${key}`] || null : null;

  const cmpLatest = latest ? compareVersions(version, latest) : null;
  const cmpMin = min ? compareVersions(version, min) : null;

  const forceUpdate = cmpMin === -1;
  const updateAvailable = forceUpdate || cmpLatest === -1;
  return {
    platform: p,
    currentVersion: parseVersion(version) ? String(version).trim() : null,
    latestVersion: latest,
    minSupportedVersion: min,
    updateAvailable,
    forceUpdate,
    storeUrl,
    message: updateAvailable ? (env.APP_UPDATE_MESSAGE || (forceUpdate ? 'Esta versão já não é suportada. Actualiza a app para continuar.' : 'Há uma nova versão do Bazares disponível.')) : null
  };
}

module.exports = { PLATFORMS, parseVersion, compareVersions, check };
