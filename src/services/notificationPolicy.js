'use strict';

/**
 * Política de notificações (lógica PURA, sem BD — testável com `node` puro).
 *
 * Categorias:
 *   orders     encomendas (nova, aceite, recusada, concluída, stock baixo/esgotado do vendedor)
 *   messages   mensagens de chat
 *   social     seguidores, reacções, comentários, menções, novos produtos de quem segues
 *   marketing  anúncios/promoções da plataforma (broadcasts do admin)
 *   system     conta, segurança, pagamentos, taxas — NUNCA desligável por categoria
 */

const PREF_FIELDS = [
  'notificationsEnabled', 'pushEnabled', 'emailEnabled',
  'orderNotifications', 'messageNotifications', 'socialNotifications', 'marketingNotifications'
];

const DEFAULT_PREFS = Object.freeze(Object.fromEntries(PREF_FIELDS.map((f) => [f, true])));

const CATEGORY_FLAG = {
  orders: 'orderNotifications',
  messages: 'messageNotifications',
  social: 'socialNotifications',
  marketing: 'marketingNotifications'
};

/** Categoria a partir do NotificationType quando o chamador não a indica. */
function categoryFor(type) {
  switch (type) {
    case 'ORDER': return 'orders';
    case 'CHAT': return 'messages';
    case 'SOCIAL': return 'social';
    case 'REVIEW': return 'social';
    default: return 'system'; // INFO/SUCCESS/WARNING/ERROR/SYSTEM: transaccionais por omissão
  }
}

const merge = (prefs) => ({ ...DEFAULT_PREFS, ...(prefs || {}) });

/** Deve criar a notificação dentro da app (e emitir em tempo real)? */
function allowedInApp(prefs, category) {
  if (category === 'system') return true;
  const p = merge(prefs);
  if (!p.notificationsEnabled) return false;
  const flag = CATEGORY_FLAG[category];
  return flag ? p[flag] === true : true;
}

/** Deve enviar push nativo (FCM)? */
function allowedPush(prefs, category) {
  const p = merge(prefs);
  if (!p.pushEnabled) return false;
  return allowedInApp(prefs, category);
}

/** Deve enviar email? (marketing por email só com emailEnabled + marketingNotifications) */
function allowedEmail(prefs, category) {
  const p = merge(prefs);
  if (!p.emailEnabled) return false;
  return allowedInApp(prefs, category);
}

/**
 * Valida o corpo de PUT /notifications/preferences: só campos conhecidos, só booleanos.
 * @returns {{ data?: object, error?: string }}
 */
function parsePrefsInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Corpo inválido.' };
  const data = {};
  for (const key of Object.keys(body)) {
    if (!PREF_FIELDS.includes(key)) continue; // ignora silenciosamente campos desconhecidos (userId, role, …)
    if (typeof body[key] !== 'boolean') return { error: `O campo "${key}" tem de ser true ou false.` };
    data[key] = body[key];
  }
  if (Object.keys(data).length === 0) return { error: 'Nenhuma preferência válida enviada.' };
  return { data };
}

module.exports = { PREF_FIELDS, DEFAULT_PREFS, categoryFor, allowedInApp, allowedPush, allowedEmail, parsePrefsInput };
