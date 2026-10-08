'use strict';

/**
 * Regras PURAS da contagem de visualizações (sem BD).
 *  - dia civil de Maputo (UTC+2, sem horário de verão)
 *  - chave de visitante = hash (nunca guarda o IP)
 *  - séries completas (dias sem visitas = 0) e variação face ao período anterior
 */
const crypto = require('crypto');
const { AppError } = require('../utils/appError');

const TARGET_TYPES = ['PRODUCT', 'BAZAR', 'REEL', 'POST', 'PROFILE'];
const MAPUTO_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const MAX_RANGE_DAYS = 365;

/** 'YYYY-MM-DD' do dia civil em Maputo. */
const dayKey = (now = new Date()) => new Date(now.getTime() + MAPUTO_OFFSET_MS).toISOString().slice(0, 10);
/** Date (meia-noite UTC do dia civil de Maputo) — é o que o Postgres guarda em colunas DATE. */
const dayDate = (now = new Date()) => new Date(`${dayKey(now)}T00:00:00.000Z`);

function parseTargetType(raw) {
  const t = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!TARGET_TYPES.includes(t)) throw new AppError(`Tipo inválido. Use: ${TARGET_TYPES.join(', ')}.`, 400, 'VIEW_BAD_TYPE');
  return t;
}

/**
 * Chave anónima do visitante. Com sessão → pelo id (estável entre dispositivos); sem sessão → HMAC(ip|user-agent|dia).
 * O dia entra no hash: a mesma pessoa não é rastreável de um dia para o outro.
 */
function visitorKey({ userId, ip, userAgent, now = new Date(), secret = process.env.JWT_ACCESS_SECRET || 'bazares' }) {
  if (userId) return `u:${userId}`;
  const h = crypto.createHmac('sha256', secret).update(`${ip || ''}|${(userAgent || '').slice(0, 200)}|${dayKey(now)}`).digest('hex');
  return `a:${h.slice(0, 32)}`;
}

/** Normaliza ?days= (1..365, por omissão 30). */
function parseDays(raw, def = 30) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new AppError('"days" inválido.', 400, 'VIEW_BAD_RANGE');
  return Math.min(n, MAX_RANGE_DAYS);
}

/** Primeiro dia (inclusive) de uma janela de `days` dias que termina hoje. */
const windowStart = (days, now = new Date()) => new Date(dayDate(now).getTime() - (days - 1) * DAY_MS);

/**
 * Preenche os dias sem linhas com zeros → o gráfico da app não tem buracos.
 * @param {{day: Date|string, views:number, uniques:number}[]} rows
 */
function fillSeries(rows, days, now = new Date()) {
  const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r]));
  const start = windowStart(days, now);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    const r = byDay.get(d);
    out.push({ day: d, views: r ? r.views : 0, uniques: r ? r.uniques : 0 });
  }
  return out;
}

/** Variação percentual (null se não há base de comparação). */
function changePct(current, previous) {
  if (!previous) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

module.exports = { TARGET_TYPES, MAX_RANGE_DAYS, dayKey, dayDate, parseTargetType, visitorKey, parseDays, windowStart, fillSeries, changePct };
