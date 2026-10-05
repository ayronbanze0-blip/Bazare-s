'use strict';

/**
 * Traduz/classifica erros devolvidos pelas operadoras (M-Pesa/e-Mola via ZumboPay).
 *
 * Antes, mensagens cruas em inglês (ex.: "The state tag Fraud_Clawback_Termination of the
 * transaction credit party restricts the fund transfer-in and the transaction fails.")
 * chegavam tal e qual ao utilizador e ficavam gravadas em rejectReason/failReason.
 *
 * Aqui: texto em português, código estável para o frontend e flag `retryable`
 * (insistir com o mesmo número num erro "RESTRICTED_ACCOUNT" nunca resolve).
 * Só lida com texto — não mexe em saldos nem em estados.
 */

const RULES = [
  {
    code: 'RESTRICTED_ACCOUNT',
    retryable: false,
    test: /fraud[_\s-]*clawback|state\s*tag|credit\s*party|restricts?\s+the\s+fund|transfer-?in|account\s+(is\s+)?(restricted|frozen|blocked|suspended)|conta\s+(restrita|bloqueada)/i,
    message: 'A conta M-Pesa/e-Mola deste número está com uma restrição da operadora e não pode receber nem movimentar este valor. Usa outro número ou o depósito com comprovativo, e contacta a operadora (Vodacom *150# / Movitel) para regularizar a conta.'
  },
  {
    code: 'INSUFFICIENT_FUNDS',
    retryable: true,
    test: /insufficient|not\s+enough\s+(funds|balance)|saldo\s+insuficiente|balance\s+(is\s+)?(too\s+)?low/i,
    message: 'Saldo insuficiente na conta M-Pesa/e-Mola. Carrega a conta e tenta de novo.'
  },
  {
    code: 'WRONG_PIN',
    retryable: true,
    test: /(wrong|invalid|incorrect)\s+pin|pin\s+(errado|inv[aá]lido)|authentication\s+failed/i,
    message: 'PIN incorreto ou não confirmado. Tenta de novo e introduz o PIN quando o pedido aparecer no telemóvel.'
  },
  {
    code: 'USER_CANCELLED',
    retryable: true,
    test: /cancel+ed\s+by\s+(the\s+)?(user|customer|subscriber)|user\s+(cancel|reject)|rejected\s+by\s+(the\s+)?(user|customer)/i,
    message: 'O pedido foi cancelado no telemóvel. Tenta de novo quando estiveres pronto.'
  },
  {
    code: 'TIMEOUT',
    retryable: true,
    test: /time[d\s-]*out|expired|no\s+response|n[aã]o\s+respondeu/i,
    message: 'O pedido expirou sem confirmação no telemóvel. Tenta de novo.'
  },
  {
    code: 'LIMIT_EXCEEDED',
    retryable: false,
    test: /(daily|transaction|monthly)\s+limit|limit\s+exceed|exceeds?\s+(the\s+)?(limit|maximum)/i,
    message: 'O valor excede o limite da tua conta M-Pesa/e-Mola. Tenta um valor menor ou outro número.'
  },
  {
    code: 'ACCOUNT_NOT_FOUND',
    retryable: false,
    test: /(subscriber|account|msisdn|customer)\s+(not\s+found|does\s+not\s+exist|inactive|not\s+registered)|not\s+registered/i,
    message: 'Este número não tem conta M-Pesa/e-Mola activa. Confirma o número e tenta de novo.'
  }
];

/**
 * @param {string|null|undefined} raw mensagem crua da operadora/ZumboPay
 * @returns {{ code: string, message: string, retryable: boolean, raw: string|null, known: boolean }}
 */
const classifyGatewayError = (raw) => {
  const text = raw == null ? '' : String(raw).trim();
  if (text) {
    for (const r of RULES) {
      if (r.test.test(text)) return { code: r.code, message: r.message, retryable: r.retryable, raw: text, known: true };
    }
  }
  return {
    code: 'GATEWAY_DECLINED',
    message: text && /[ãçõáéíóúâêô]/i.test(text) ? text : 'O pagamento não foi concluído pela operadora. Tenta de novo ou usa outro método.',
    retryable: true,
    raw: text || null,
    known: false
  };
};

/** Atalho: só o texto amigável (para rejectReason/failReason/notificações). */
const friendlyGatewayMessage = (raw) => classifyGatewayError(raw).message;

module.exports = { classifyGatewayError, friendlyGatewayMessage };
