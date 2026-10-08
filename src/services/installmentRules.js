'use strict';

/**
 * Regras PURAS de parcelas (sem BD). Tudo em cêntimos inteiros; a última parcela absorve o resto da divisão
 * para que a soma das parcelas seja EXACTAMENTE o valor a pagar.
 */
const { AppError } = require('../utils/appError');
const V = require('../utils/validate');

const DAY_MS = 86400000;
const LIMITS = Object.freeze({ maxInstallments: 12, minFrequencyDays: 7, maxFrequencyDays: 60, maxInterestPct: 30, minDownPaymentPct: 10 });

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
/** Multa por atraso (% do valor da parcela), configurável por env; aplicada UMA vez. */
const lateFeePct = (env = process.env) => Math.min(num(env.INSTALLMENT_LATE_FEE_PCT, 2), 20);
/** Dias de atraso após os quais o plano passa a INCUMPRIDO. */
const defaultAfterDays = (env = process.env) => Math.max(1, Math.round(num(env.INSTALLMENT_DEFAULT_AFTER_DAYS, 15)));
/** Horas de tolerância depois do vencimento antes de aplicar a multa e marcar ATRASADA. */
const graceHours = (env = process.env) => Math.min(num(env.INSTALLMENT_GRACE_HOURS, 24), 24 * 7);
/** Intervalo mínimo entre tentativas de débito automático da mesma parcela. */
const autoPayRetryHours = (env = process.env) => Math.max(1, num(env.INSTALLMENT_AUTOPAY_RETRY_HOURS, 6));
/** Máximo de planos activos em simultâneo por comprador. */
const maxActivePlans = (env = process.env) => Math.max(1, Math.round(num(env.INSTALLMENT_MAX_ACTIVE_PLANS, 5)));
/** Aviso X dias antes do vencimento. */
const reminderDaysBefore = (env = process.env) => Math.max(0, Math.round(num(env.INSTALLMENT_REMINDER_DAYS, 2)));

/** Valida as definições de parcelas de um vendedor. */
function parseSettingsInput(body) {
  V.bodyObject(body);
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (has('enabled')) out.enabled = V.bool(body.enabled, 'enabled', { def: false });
  if (has('maxInstallments')) out.maxInstallments = V.int(body.maxInstallments, 'maxInstallments', { min: 2, max: LIMITS.maxInstallments });
  if (has('minOrderAmount')) out.minOrderAmount = V.money(body.minOrderAmount, 'minOrderAmount', { min: 0 });
  if (has('downPaymentPct')) out.downPaymentPct = V.pct(body.downPaymentPct, 'downPaymentPct');
  if (has('interestPct')) out.interestPct = V.pct(body.interestPct, 'interestPct');
  if (has('frequencyDays')) out.frequencyDays = V.int(body.frequencyDays, 'frequencyDays', { min: LIMITS.minFrequencyDays, max: LIMITS.maxFrequencyDays });
  if (out.downPaymentPct !== undefined && out.downPaymentPct < LIMITS.minDownPaymentPct) {
    throw new AppError(`A entrada mínima tem de ser pelo menos ${LIMITS.minDownPaymentPct}%.`, 400, 'INSTALLMENT_BAD_DOWN_PAYMENT');
  }
  if (out.downPaymentPct !== undefined && out.downPaymentPct > 90) throw new AppError('A entrada não pode passar de 90%.', 400, 'INSTALLMENT_BAD_DOWN_PAYMENT');
  if (out.interestPct !== undefined && out.interestPct > LIMITS.maxInterestPct) throw new AppError(`O juro não pode passar de ${LIMITS.maxInterestPct}%.`, 400, 'INSTALLMENT_BAD_INTEREST');
  return out;
}

/**
 * Constrói o calendário de pagamento.
 * @param {{ total:number, downPaymentPct:number, count:number, interestPct:number, frequencyDays:number, now?:Date }} p
 * @returns {{ down:number, financed:number, interest:number, totalPayable:number,
 *             parcels:{number:number, amount:number, dueDate:Date}[] }}
 */
function buildSchedule({ total, downPaymentPct, count, interestPct = 0, frequencyDays = 30, now = new Date() }) {
  const totalC = toCents(total);
  if (!(totalC > 0)) throw new AppError('Total inválido.', 400, 'INSTALLMENT_BAD_TOTAL');
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxInstallments) throw new AppError(`Número de parcelas inválido (1 a ${LIMITS.maxInstallments}).`, 400, 'INSTALLMENT_BAD_COUNT');

  const downC = Math.min(totalC - 1, Math.max(1, Math.round((totalC * downPaymentPct) / 100)));
  const financedC = totalC - downC;
  const interestC = Math.round((financedC * interestPct) / 100); // juro simples sobre o financiado
  const toSplit = financedC + interestC;
  const base = Math.floor(toSplit / count);
  const remainder = toSplit - base * count;

  const parcels = [];
  for (let i = 1; i <= count; i++) {
    const amountC = i === count ? base + remainder : base;
    parcels.push({ number: i, amount: fromCents(amountC), dueDate: new Date(now.getTime() + i * frequencyDays * DAY_MS) });
  }
  return { down: fromCents(downC), financed: fromCents(financedC), interest: fromCents(interestC), totalPayable: fromCents(downC + toSplit), parcels };
}

/** Multa por atraso para um valor (cêntimos exactos). */
function lateFeeFor(amount, pct = lateFeePct()) {
  return fromCents(Math.round((toCents(amount) * pct) / 100));
}

/** A condição do vendedor permite este plano? Lança AppError com o motivo. */
function assertPlanAllowed(setting, { total, count, sellerName = 'este vendedor' }) {
  if (!setting || !setting.enabled) throw new AppError(`${sellerName} não aceita pagamento em parcelas.`, 400, 'INSTALLMENTS_NOT_AVAILABLE');
  if (!Number.isInteger(count) || count < 2) throw new AppError('Escolhe pelo menos 2 parcelas.', 400, 'INSTALLMENT_BAD_COUNT');
  if (count > setting.maxInstallments) throw new AppError(`${sellerName} permite no máximo ${setting.maxInstallments} parcelas.`, 400, 'INSTALLMENT_COUNT_EXCEEDED', { maxInstallments: setting.maxInstallments });
  if (toCents(total) < toCents(setting.minOrderAmount)) {
    throw new AppError(`Para pagar em parcelas a compra a ${sellerName} tem de ser de pelo menos ${Number(setting.minOrderAmount).toLocaleString('pt-MZ')} MT.`, 400, 'INSTALLMENT_MIN_ORDER', { minOrderAmount: setting.minOrderAmount });
  }
}

/**
 * Estado de um plano a partir das suas parcelas (função pura usada pelo serviço e pelos testes).
 * - todas PAGA/CANCELADA sem pendentes → COMPLETED
 * - alguma ATRASADA há mais de `defaultAfterDays` → DEFAULTED
 */
function derivePlanStatus(installments, now = new Date(), { defaultDays = defaultAfterDays() } = {}) {
  const open = installments.filter((i) => i.status === 'PENDENTE' || i.status === 'ATRASADA');
  if (open.length === 0) return 'COMPLETED';
  const worstOverdueMs = open
    .filter((i) => i.status === 'ATRASADA')
    .reduce((m, i) => Math.max(m, now.getTime() - new Date(i.dueDate).getTime()), 0);
  return worstOverdueMs > defaultDays * DAY_MS ? 'DEFAULTED' : 'ACTIVE';
}

module.exports = {
  LIMITS, DAY_MS,
  lateFeePct, defaultAfterDays, reminderDaysBefore, graceHours, autoPayRetryHours, maxActivePlans,
  parseSettingsInput, buildSchedule, lateFeeFor, assertPlanAllowed, derivePlanStatus,
  toCents, fromCents
};
