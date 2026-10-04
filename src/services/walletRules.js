'use strict';

/**
 * Regras puras da wallet (sem BD) — testáveis em tests/unit/walletRules.test.js.
 * Tudo o que depende de Prisma vive em walletFlowService.js.
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Limites configuráveis por env (valores em MT). Lidos a cada chamada para poderem mudar sem deploy de código. */
const getLimits = (env = process.env) => ({
  minDeposit: num(env.WALLET_MIN_DEPOSIT, 10),
  maxDeposit: num(env.WALLET_MAX_DEPOSIT, 100000),
  minWithdraw: num(env.WALLET_MIN_WITHDRAW, 50),
  maxWithdraw: num(env.WALLET_MAX_WITHDRAW, 50000),
  dailyWithdraw: num(env.WALLET_DAILY_WITHDRAW, 100000),
  minTransfer: num(env.WALLET_MIN_TRANSFER, 1),
  maxTransfer: num(env.WALLET_MAX_TRANSFER, 50000),
  dailyTransfer: num(env.WALLET_DAILY_TRANSFER, 100000),
  moneyRequestTtlHours: num(env.WALLET_REQUEST_TTL_HOURS, 72)
});

/**
 * Converte o valor recebido (número ou string) em MT com no máximo 2 casas.
 * Devolve { ok, value } ou { ok:false, error }.
 */
const parseAmount = (raw, { min = 0.01, max = Infinity } = {}) => {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
    return { ok: false, error: 'Indique o valor.' };
  }
  const str = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
  const n = typeof str === 'number' ? str : Number(str);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Valor inválido.' };
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) return { ok: false, error: 'O valor não pode ter mais de 2 casas decimais.' };
  const value = cents / 100;
  const fmt = (x) => x.toLocaleString('pt-MZ');
  if (value < min) return { ok: false, error: `Valor mínimo: ${fmt(min)} MT.` };
  if (value > max) return { ok: false, error: `Valor máximo por operação: ${fmt(max)} MT.` };
  return { ok: true, value };
};

const round2 = (n) => Math.round(n * 100) / 100;

// ─── PIN ──────────────────────────────────────────────────────────
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const isValidPinFormat = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin);

/** PINs triviais: todos iguais (1111) ou sequência crescente/decrescente (1234, 4321). */
const isWeakPin = (pin) => {
  if (!isValidPinFormat(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return asc || desc;
};

/** Minutos que faltam até o PIN desbloquear (0 se não está bloqueado). */
const pinLockRemainingMin = (lockedUntil, now = new Date()) => {
  if (!lockedUntil) return 0;
  const ms = new Date(lockedUntil).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
};

// ─── Datas (Moçambique = UTC+2, sem horário de verão) ─────────────
const MAPUTO_OFFSET_MS = 2 * 60 * 60 * 1000;

/** Início do dia em Maputo (00:00 local) como instante UTC. */
const startOfDayMaputo = (now = new Date()) => {
  const shifted = new Date(now.getTime() + MAPUTO_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MAPUTO_OFFSET_MS);
};

const startOfMonthMaputo = (now = new Date()) => {
  const shifted = new Date(now.getTime() + MAPUTO_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MAPUTO_OFFSET_MS);
};

/** Aceita YYYY-MM-DD (interpretado em hora de Maputo) ou ISO completo; devolve Date ou null. */
const parseDateParam = (raw, { endOfDay = false } = {}) => {
  if (!raw || typeof raw !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return null;
    const start = new Date(d.getTime() - MAPUTO_OFFSET_MS);
    return endOfDay ? new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) : start;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ─── Texto / identificadores ──────────────────────────────────────
const cleanText = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

const isValidIdempotencyKey = (k) => typeof k === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(k);

/** URL de comprovativo: só https, sem espaços, tamanho limitado. */
const isValidProofUrl = (u) => {
  if (typeof u !== 'string' || u.length > 500 || /\s/.test(u)) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Esconde o meio de um número: 258841234567 → 258 84 ••• 567 (para mostrar ao pagador). */
const maskPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 6) return null;
  return `${d.slice(0, 5)}•••${d.slice(-3)}`;
};

// ─── Extracto ─────────────────────────────────────────────────────
/** Direcção de um movimento para a UI: 'IN' | 'OUT'. Usa o ledger como fonte única de verdade. */
const directionOf = (tx) => {
  const { signedAmount } = require('./ledgerService');
  const s = signedAmount({ type: tx.type, referenceType: tx.referenceType, amount: tx.amount });
  if (s === null) return null;
  return s >= 0 ? 'IN' : 'OUT';
};

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Mitiga injecção de fórmulas ao abrir no Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const statementToCsv = (transactions) => {
  const header = ['Data', 'Tipo', 'Direcção', 'Valor (MT)', 'Saldo após (MT)', 'Estado', 'Descrição', 'Referência'];
  const rows = transactions.map((t) => [
    new Date(t.createdAt).toISOString(),
    t.type,
    directionOf(t) || '',
    t.amount,
    t.balanceAfter,
    t.status,
    t.description,
    t.referenceId || ''
  ]);
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
};

module.exports = {
  getLimits, parseAmount, round2,
  PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES, isValidPinFormat, isWeakPin, pinLockRemainingMin,
  startOfDayMaputo, startOfMonthMaputo, parseDateParam,
  cleanText, isValidIdempotencyKey, isValidProofUrl, maskPhone,
  directionOf, csvCell, statementToCsv
};
