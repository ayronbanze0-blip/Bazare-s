'use strict';

const prisma = require('../config/database');
const { ok, badRequest, serverError } = require('../utils/response');
const logger = require('../utils/logger');

// Vocabulário fixo — ver comentário no topo de js/analytics.js no
// frontend. Eventos fora desta lista são ignorados silenciosamente
// (não rejeitam o lote todo) para não haver perda de dados por causa
// de UM evento mal formado a acompanhar 19 bons.
const KNOWN_EVENTS = new Set([
  'page_view',
  'product_viewed',
  'product_published',
  'checkout_started',
  'order_created',
  'search_performed',
  'funnel_step',
  'feature_used',
  'api_error',
  'api_slow',
  'client_error'
]);

const MAX_BATCH = 50;          // um pouco acima do MAX_BATCH do frontend (20), por segurança
const MAX_STRING_LEN = 500;    // corta strings anormalmente grandes (URLs/referrers exóticos)
const MAX_PROPERTIES_KEYS = 40;

function clampString(v) {
  if (typeof v !== 'string') return null;
  return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
}

// Sanitiza `properties`: só tipos simples (string/number/boolean/null),
// nada de objectos aninhados profundos ou arrays gigantes — isto é
// telemetria, não um lugar para guardar documentos.
function sanitizeProperties(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const out = {};
  let count = 0;
  for (const [key, val] of Object.entries(props)) {
    if (count >= MAX_PROPERTIES_KEYS) break;
    if (val === null || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'string') {
      out[key] = clampString(val);
    } else if (Array.isArray(val)) {
      out[key] = val.slice(0, 20).map((v) => (typeof v === 'string' ? clampString(v) : v));
    } else {
      // objecto aninhado — mantém, mas raso (não recursa mais fundo)
      out[key] = val;
    }
    count++;
  }
  return out;
}

function sanitizeEvent(raw, req) {
  if (!raw || typeof raw !== 'object') return null;
  const event = clampString(raw.event);
  if (!event || !KNOWN_EVENTS.has(event)) return null;

  let occurredAt = null;
  if (raw.timestamp) {
    const d = new Date(raw.timestamp);
    if (!isNaN(d.getTime())) occurredAt = d;
  }

  return {
    event,
    properties: sanitizeProperties(raw.properties),
    anonId: clampString(raw.anon_id),
    sessionId: clampString(raw.session_id),
    // O userId do corpo nunca é fonte de verdade sozinho — só se
    // confirma quando bate certo com o utilizador autenticado no
    // pedido (req.user, via optionalAuth). Visitante anónimo ou
    // token inválido = fica null, não se aceita "vestir" outro user.
    userId: req.user?.id && req.user.id === raw.user_id ? raw.user_id : null,
    userRole: clampString(raw.user_role),
    page: clampString(raw.page),
    url: clampString(raw.url),
    referrer: clampString(raw.referrer),
    occurredAt
  };
}

// POST /api/analytics/events
// Body: { events: [ {event, properties, anon_id, session_id, user_id,
//                     user_role, page, url, referrer, timestamp}, ... ] }
// Endpoint público (optionalAuth) — recebe de visitantes anónimos e
// autenticados. Sempre responde 2xx quando o pedido em si é válido,
// mesmo que todos os eventos venham inválidos — assim o frontend nunca
// fica preso a reenviar lixo indefinidamente; só se o formato do
// pedido estiver mesmo errado é que devolve 400.
exports.trackEvents = async (req, res) => {
  try {
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return badRequest(res, 'Corpo inválido: esperado { events: [...] }.');
    }

    const batch = events.slice(0, MAX_BATCH);
    const rows = batch.map((e) => sanitizeEvent(e, req)).filter(Boolean);

    if (rows.length) {
      await prisma.analyticsEvent.createMany({ data: rows });
    }

    return ok(res, { accepted: rows.length, rejected: batch.length - rows.length }, 'Eventos registados.');
  } catch (err) {
    logger.error(`[Analytics.trackEvents] ${err.message}`);
    // Falha "suave": nunca queremos que analytics quebrado afecte a
    // percepção de saúde da API para quem está a monitorizar erros 5xx
    // em massa por causa disto. Ainda assim devolve 500 real — o
    // frontend só trata isso como "tenta outra vez depois".
    return serverError(res, 'Não foi possível registar os eventos.');
  }
};

// GET /api/analytics/routes-health?hours=24
// Resposta directa às perguntas que motivaram isto: que rota está a
// falhar, que rota está lenta, quantos UTILIZADORES DIFERENTES (não só
// quantos pedidos) foram afectados por cada uma — isso é o sinal real
// de "muita gente a falhar na mesma acção", não só volume bruto.
exports.routesHealth = async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 30);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw`
      SELECT
        properties->>'path'   AS path,
        properties->>'method' AS method,
        event,
        COUNT(*)::int AS count,
        COUNT(DISTINCT COALESCE("userId", "anonId"))::int AS affected_users,
        AVG((properties->>'duration_ms')::numeric)::int AS avg_duration_ms
      FROM "AnalyticsEvent"
      WHERE event IN ('api_error', 'api_slow')
        AND "receivedAt" >= ${since}
        AND properties->>'path' IS NOT NULL
      GROUP BY path, method, event
      ORDER BY count DESC
      LIMIT 50
    `;

    return ok(res, { sinceHours: hours, routes: rows });
  } catch (err) {
    logger.error(`[Analytics.routesHealth] ${err.message}`);
    return serverError(res);
  }
};
// Visão agregada simples — contagens por evento, por dia. Pensado para
// um pequeno dashboard interno (admin), não para substituir uma
// ferramenta de BI a sério se o volume crescer muito.
exports.summary = async (req, res) => {
  try {
    const { from, to, event } = req.query;
    const where = {
      ...(event && KNOWN_EVENTS.has(event) && { event }),
      ...((from || to) && {
        receivedAt: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) })
        }
      })
    };

    const grouped = await prisma.analyticsEvent.groupBy({
      by: ['event'],
      where,
      _count: { _all: true },
      orderBy: { _count: { event: 'desc' } }
    });

    return ok(res, {
      totals: grouped.map((g) => ({ event: g.event, count: g._count._all }))
    });
  } catch (err) {
    logger.error(`[Analytics.summary] ${err.message}`);
    return serverError(res);
  }
};
