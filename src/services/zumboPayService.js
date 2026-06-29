'use strict';

/**
 * ZumboPay Service — integração com a API da ZumboPay
 * (https://zumbopay.com/api/public/v1) para cobrança via STK push
 * (M-Pesa / e-Mola) e validação de webhooks.
 *
 * Variáveis de ambiente necessárias (ver .env.example):
 *   ZUMBOPAY_API_KEY        — chave da API (zk_live_... ou zk_test_...)
 *   ZUMBOPAY_MERCHANT_ID    — MCH_XXXXXXXXXX
 *   ZUMBOPAY_BASE_URL       — por defeito https://zumbopay.com/api/public/v1
 *   ZUMBOPAY_WALLET_MPESA   — wallet_id (UUID) da carteira M-Pesa no painel ZumboPay
 *   ZUMBOPAY_WALLET_EMOLA   — wallet_id (UUID) da carteira e-Mola no painel ZumboPay
 *   ZUMBOPAY_WEBHOOK_SECRET — secret usado para validar a assinatura HMAC do webhook
 *
 * Para obter ZUMBOPAY_WALLET_MPESA / ZUMBOPAY_WALLET_EMOLA: chamar
 * validateMerchant() uma vez (ou GET /wallets) e copiar o "id" de cada
 * carteira do painel ZumboPay → Carteiras.
 *
 * Nota: desde a versão de 2026-06-22 da API, wallet_id passou a ser
 * opcional em /charges (a ZumboPay resolve automaticamente pela carteira
 * activa do canal) — por isso só o enviamos quando configurado.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const BASE_URL = process.env.ZUMBOPAY_BASE_URL || 'https://zumbopay.com/api/public/v1';
const API_KEY = process.env.ZUMBOPAY_API_KEY;
const MERCHANT_ID = process.env.ZUMBOPAY_MERCHANT_ID;
const WEBHOOK_SECRET = process.env.ZUMBOPAY_WEBHOOK_SECRET;

const isConfigured = () => Boolean(API_KEY && MERCHANT_ID);

/**
 * Normaliza um número moçambicano para o formato 258XXXXXXXXX exigido
 * pela ZumboPay (msisdn), e detecta o operador pelo prefixo:
 *   84 / 85 → M-Pesa (Vodacom)
 *   86 / 87 → e-Mola (Movitel)
 */
const normalizeMsisdn = (raw) => {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  // Remove prefixo internacional duplicado, normaliza para 258XXXXXXXXX
  if (digits.startsWith('00258')) digits = digits.slice(3);
  if (digits.startsWith('258')) digits = digits.slice(3);
  if (digits.length === 9) digits = digits; // já é só o número local (8XXXXXXXX)
  return `258${digits.slice(-9)}`;
};

const detectMethod = (msisdnRaw) => {
  const msisdn = normalizeMsisdn(msisdnRaw);
  if (!msisdn) return null;
  const prefix = msisdn.slice(3, 5); // 2 dígitos depois do 258
  if (['84', '85'].includes(prefix)) return 'MPESA';
  if (['86', '87'].includes(prefix)) return 'EMOLA';
  return null;
};

const walletIdForMethod = (method) => {
  // NOTA: a documentação técnica da ZumboPay mostra exemplos de wallet_id
  // em formato UUID, mas o próprio painel ZumboPay → Carteiras exibe o
  // identificador da carteira como o código de 6 dígitos (ex: "Wallet
  // ID: 397476"). Confirmado por captura de ecrã do painel — é esse
  // valor que deve ser enviado em wallet_id, não um UUID. Por isso,
  // enviamos o valor configurado tal como está, sem validar formato.
  const raw = method === 'MPESA'
    ? process.env.ZUMBOPAY_WALLET_MPESA
    : method === 'EMOLA'
      ? process.env.ZUMBOPAY_WALLET_EMOLA
      : null;
  return raw ? raw.trim() : null;
};

const apiFetch = async (path, { method = 'GET', body = null, idempotencyKey = null } = {}) => {
  if (!isConfigured()) {
    throw new Error('ZumboPay não está configurada (faltam ZUMBOPAY_API_KEY / ZUMBOPAY_MERCHANT_ID).');
  }

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'X-Merchant-Id': MERCHANT_ID,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { httpStatus: res.status, data };
};

/**
 * Dispara um STK push (cobrança directa C2B) para o telefone do
 * vendedor, no valor da comissão pendente.
 *
 * Devolve { status: 'success' | 'pending' | 'declined', reference, channel, raw }
 */
const initiateCharge = async ({ amount, msisdn, customerName, sourceId }) => {
  const method = detectMethod(msisdn);
  if (!method) {
    throw new Error('Número de telefone não reconhecido como M-Pesa (84/85) ou e-Mola (86/87).');
  }

  const normalized = normalizeMsisdn(msisdn);
  const walletId = walletIdForMethod(method);

  const body = {
    amount: Math.round(amount * 100) / 100,
    msisdn: normalized,
    customer_name: customerName || undefined,
    source_id: sourceId
  };
  if (walletId) body.wallet_id = walletId;

  const { httpStatus, data } = await apiFetch('/charges', {
    method: 'POST',
    body,
    idempotencyKey: sourceId
  });

  if (httpStatus === 200) {
    return {
      status: data?.data?.status === 'success' ? 'success' : 'unknown',
      reference: data?.data?.reference || null,
      channel: data?.data?.channel || method.toLowerCase(),
      raw: data
    };
  }
  if (httpStatus === 202) {
    return {
      status: 'pending',
      reference: data?.data?.reference || null,
      channel: method.toLowerCase(),
      raw: data
    };
  }
  if (httpStatus === 402) {
    return {
      status: 'declined',
      reference: null,
      channel: method.toLowerCase(),
      failReason: data?.error?.message || 'Pagamento recusado.',
      raw: data
    };
  }

  // 400/401/403/404/429/5xx — erro de pedido/infra
  const message = data?.error?.message || `Erro inesperado da ZumboPay (HTTP ${httpStatus}).`;
  logger.error(`[ZumboPay] charge failed: HTTP ${httpStatus} — ${message}`);
  logger.error(`[ZumboPay] resposta completa: ${JSON.stringify(data)}`);
  logger.error(`[ZumboPay] payload enviado: ${JSON.stringify({ ...body, msisdn: '***' })}`);
  throw new Error(message);
};

/**
 * Endpoint de diagnóstico — confirma que as credenciais, carteiras e
 * webhook estão correctamente configurados antes de ir para produção.
 */
const validateMerchant = async () => {
  const { httpStatus, data } = await apiFetch('/merchant/validate');
  if (httpStatus !== 200) {
    throw new Error(data?.error?.message || `Falha ao validar credenciais ZumboPay (HTTP ${httpStatus}).`);
  }
  return data?.data;
};

/**
 * Verifica a assinatura HMAC-SHA256 de um webhook da ZumboPay.
 * `rawBody` deve ser o corpo em bruto (Buffer ou string), NÃO o JSON
 * já parseado — caso contrário a assinatura nunca vai coincidir.
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!WEBHOOK_SECRET) {
    logger.warn('[ZumboPay] ZUMBOPAY_WEBHOOK_SECRET não configurado — a aceitar webhook sem validação de assinatura.');
    return true;
  }
  if (!signature) return false;

  try {
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (err) {
    logger.error(`[ZumboPay] Erro a verificar assinatura do webhook: ${err.message}`);
    return false;
  }
};

module.exports = {
  isConfigured,
  normalizeMsisdn,
  detectMethod,
  initiateCharge,
  validateMerchant,
  verifyWebhookSignature
};
