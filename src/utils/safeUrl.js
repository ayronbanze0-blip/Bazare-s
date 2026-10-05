'use strict';

/**
 * Validação de URLs fornecidos por utilizadores (anti-SSRF / anti-lixo).
 *
 * `isPublicHttpsUrl` só aceita https:// para um nome de domínio público: recusa credenciais no URL
 * (https://user:pass@host), portas fora de 443, "localhost", IPs literais (v4/v6) e domínios
 * internos (.local, .internal, .localhost). Isto é uma validação SINTÁCTICA — não resolve DNS.
 * Quem fizer o pedido HTTP a esse URL (ex.: entrega de webhooks) tem de, além disto, resolver o
 * DNS e recusar IPs privados no momento da ligação (DNS rebinding) e não seguir redirects.
 */
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet'];

function isPublicHttpsUrl(raw, { maxLength = 500 } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost') return false;
  if (host.startsWith('[') || host.includes(':')) return false;           // IPv6 literal
  if (/^\d+(\.\d+){0,3}$/.test(host)) return false;                         // IPv4 literal (inclui formas curtas)
  if (/^0x[0-9a-f]+$/i.test(host)) return false;                            // IPv4 em hex
  if (!host.includes('.')) return false;                                    // nome interno sem ponto
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

module.exports = { isPublicHttpsUrl };
