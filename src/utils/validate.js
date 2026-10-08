'use strict';

/**
 * Validação/normalização de entrada — funções PURAS (sem BD), cada uma devolve o valor limpo ou lança
 * AppError 400. Nunca confiar no formato de req.body: tipos, tamanhos e intervalos são verificados aqui.
 */
const { AppError } = require('./appError');
const { isPublicHttpsUrl } = require('./safeUrl');

const fail = (msg, code = 'VALIDATION_ERROR') => { throw new AppError(msg, 400, code); };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Remove caracteres de controlo (mantém \n e \t) e normaliza espaços
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const isBlank = (v) => v === undefined || v === null || v === '';

/** Texto: string, trim, sem controlo, tamanho min..max. `required:false` + vazio → null. */
function text(v, label, { min = 1, max = 255, required = true, multiline = false } = {}) {
  if (isBlank(v)) {
    if (required) fail(`"${label}" é obrigatório.`);
    return null;
  }
  if (typeof v !== 'string') fail(`"${label}" inválido.`);
  let s = v.replace(CONTROL_RE, '').trim();
  if (!multiline) s = s.replace(/\s+/g, ' ');
  if (s.length < min) fail(`"${label}" demasiado curto (mín. ${min} caracteres).`);
  if (s.length > max) fail(`"${label}" demasiado longo (máx. ${max} caracteres).`);
  return s;
}

/** Inteiro (aceita "3"). */
function int(v, label, { min = -Infinity, max = Infinity, required = true, def } = {}) {
  if (isBlank(v)) {
    if (def !== undefined) return def;
    if (required) fail(`"${label}" é obrigatório.`);
    return null;
  }
  const n = typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n)) fail(`"${label}" tem de ser um número inteiro.`);
  if (n < min) fail(`"${label}" tem de ser pelo menos ${min}.`);
  if (n > max) fail(`"${label}" tem de ser no máximo ${max}.`);
  return n;
}

/** Valor monetário em MT com no máximo 2 casas (aceita "12,50"). Devolve número arredondado a 2 casas. */
function money(v, label, { min = 0, max = 1e9, required = true, def } = {}) {
  if (isBlank(v)) {
    if (def !== undefined) return def;
    if (required) fail(`"${label}" é obrigatório.`);
    return null;
  }
  if (typeof v === 'boolean') fail(`"${label}" inválido.`);
  const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`"${label}" inválido.`);
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) fail(`"${label}" não pode ter mais de 2 casas decimais.`);
  const value = cents / 100;
  if (value < min) fail(`"${label}" tem de ser pelo menos ${min}.`);
  if (value > max) fail(`"${label}" tem de ser no máximo ${max}.`);
  return value;
}

/** Percentagem (0..100) com até 2 casas. */
function pct(v, label, opts = {}) {
  return money(v, label, { min: 0, max: 100, ...opts });
}

function oneOf(v, label, allowed, { required = true, def } = {}) {
  if (isBlank(v)) {
    if (def !== undefined) return def;
    if (required) fail(`"${label}" é obrigatório.`);
    return null;
  }
  const s = typeof v === 'string' ? v.trim().toUpperCase() : v;
  if (!allowed.includes(s)) fail(`"${label}" inválido. Valores aceites: ${allowed.join(', ')}.`);
  return s;
}

function bool(v, label, { def } = {}) {
  if (isBlank(v)) return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return fail(`"${label}" tem de ser true ou false.`);
}

function id(v, label = 'id') {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64 || /\s/.test(v)) fail(`"${label}" inválido.`);
  return v;
}

function uuid(v, label = 'id') {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail(`"${label}" inválido.`);
  return v;
}

/** Data ISO (ou timestamp) → Date válida. */
function date(v, label, { required = true } = {}) {
  if (isBlank(v)) {
    if (required) fail(`"${label}" é obrigatório.`);
    return null;
  }
  const d = new Date(v);
  if (typeof v !== 'string' && typeof v !== 'number') fail(`"${label}" inválida.`);
  if (Number.isNaN(d.getTime())) fail(`"${label}" inválida.`);
  return d;
}

/** Lista de URLs https públicos (máx. n). */
function urls(v, label, { max = 5, required = false } = {}) {
  if (isBlank(v)) {
    if (required) fail(`"${label}" é obrigatório.`);
    return [];
  }
  if (!Array.isArray(v)) fail(`"${label}" tem de ser uma lista.`);
  if (v.length > max) fail(`"${label}": no máximo ${max} ligações.`);
  for (const u of v) if (!isPublicHttpsUrl(u)) fail(`"${label}" contém uma ligação inválida (só https:// públicos).`);
  return [...new Set(v)];
}

/** Lista de ids (strings), sem repetidos, máx. n. */
function idList(v, label, { max = 100 } = {}) {
  if (isBlank(v)) return [];
  if (!Array.isArray(v)) fail(`"${label}" tem de ser uma lista.`);
  if (v.length > max) fail(`"${label}": no máximo ${max} itens.`);
  return [...new Set(v.map((x) => id(x, label)))];
}

/** Garante que o corpo é um objecto simples. */
function bodyObject(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Corpo do pedido inválido.');
  return b;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { text, int, money, pct, oneOf, bool, id, uuid, date, urls, idList, bodyObject, round2, isBlank, UUID_RE };
