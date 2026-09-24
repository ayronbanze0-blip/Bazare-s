'use strict';

/**
 * Pagamento TARDIO — decisão pura (sem BD, testável com `node` puro).
 *
 * Situação: o ZumboPay confirma (`payment.succeeded`) um pagamento que o sistema já tinha marcado
 * FALHADA (expirou ao fim de STK_INFLIGHT_EXPIRY_MIN) ou CANCELADA (o vendedor cancelou), mas o
 * cliente acabou por pôr o PIN — o dinheiro SAIU do telemóvel.
 *
 * Política HÍBRIDA (decidida pelo dono do produto):
 *   - Caso normal → credita AUTOMATICAMENTE (comissão: só se a dívida actual ainda cobre o valor
 *     pago, ou seja, não houve outro pagamento entretanto; Premium: activa/estende).
 *   - Caso ambíguo → NÃO credita: fica para revisão manual (AuditLog + Sentry + aviso ao admin) e o
 *     cliente é avisado para NÃO pagar outra vez.
 */

const EPSILON = 0.005;
const LATE_STATUSES = ['FALHADA', 'CANCELADA'];

const isLateStatus = (status) => LATE_STATUSES.includes(status);

/**
 * O valor que o gateway diz ter cobrado bate com o do pagamento? Se o gateway não enviar o valor,
 * não há como saber → não bloqueia (a assinatura HMAC já garante a autenticidade do evento).
 * Se enviar um valor diferente (ou noutra unidade, ex.: cêntimos) → revisão manual (direcção segura).
 */
function amountMismatch(eventAmount, expected) {
  if (eventAmount === undefined || eventAmount === null || eventAmount === '') return false;
  const n = typeof eventAmount === 'number' ? eventAmount : Number(String(eventAmount).replace(',', '.'));
  if (!Number.isFinite(n)) return true;
  return Math.abs(n - expected) > 0.01;
}

/**
 * @returns {{ action: 'AUTO_CREDIT'|'MANUAL_REVIEW'|'NOOP', reason?: string }}
 */
function decideLateCommission({ payment, pendingFees, eventAmount }) {
  if (!payment || !isLateStatus(payment.status)) return { action: 'NOOP' };
  if (amountMismatch(eventAmount, payment.amount)) return { action: 'MANUAL_REVIEW', reason: 'AMOUNT_MISMATCH' };
  if (!(pendingFees + EPSILON >= payment.amount)) return { action: 'MANUAL_REVIEW', reason: 'PENDING_FEES_LOWER' };
  return { action: 'AUTO_CREDIT' };
}

/** Premium: pagar duas vezes = estender duas vezes (correcto); só bloqueia se o valor não bater. */
function decideLatePremium({ subscription, eventAmount }) {
  if (!subscription || !isLateStatus(subscription.status)) return { action: 'NOOP' };
  if (amountMismatch(eventAmount, subscription.amount)) return { action: 'MANUAL_REVIEW', reason: 'AMOUNT_MISMATCH' };
  return { action: 'AUTO_CREDIT' };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = { LATE_STATUSES, isLateStatus, amountMismatch, decideLateCommission, decideLatePremium, round2, EPSILON };
