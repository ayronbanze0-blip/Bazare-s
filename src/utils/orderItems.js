'use strict';

/**
 * Validação/normalização pura dos dados de uma encomenda (sem dependências —
 * testável com `node` puro). O controller confia no resultado, não em req.body.
 */

const MAX_ITEMS = 50;
const MAX_QTY_PER_ITEM = 999;

/**
 * - `items` tem de ser um array (≤ 50) de { productId: string, qty: inteiro 1..999 }
 * - linhas repetidas do mesmo produto são fundidas (somam quantidades)
 * @returns {{ items: {productId:string, qty:number}[] } | { error: string }}
 */
function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Nenhum item na encomenda.' };
  if (items.length > MAX_ITEMS) return { error: `Demasiados itens (máx. ${MAX_ITEMS}).` };

  const merged = new Map();
  for (const raw of items) {
    const productId = raw && typeof raw.productId === 'string' ? raw.productId.trim() : '';
    if (!productId || productId.length > 64) return { error: 'Produto inválido na encomenda.' };
    // Aceita número inteiro ou string numérica inteira ("2") — o frontend actual pode enviar qualquer um.
    const qty = typeof raw.qty === 'string' && /^\d{1,4}$/.test(raw.qty.trim()) ? Number(raw.qty) : raw.qty;
    if (!Number.isInteger(qty) || qty < 1) return { error: 'Quantidade inválida (tem de ser um número inteiro maior que zero).' };
    merged.set(productId, (merged.get(productId) || 0) + qty);
  }
  const out = [];
  for (const [productId, qty] of merged) {
    if (qty > MAX_QTY_PER_ITEM) return { error: `Quantidade máxima por produto: ${MAX_QTY_PER_ITEM}.` };
    out.push({ productId, qty });
  }
  return { items: out };
}

const PHONE_RE = /^[+\d\s()-]{6,30}$/;

/**
 * Valida tipo/tamanho dos campos de texto livre (o controller sanitiza depois).
 * Campos opcionais podem ser undefined/null.
 * @returns {string|null} mensagem de erro, ou null se tudo OK
 */
function validateOrderText({ buyerName, buyerPhone, address, payment, size, color, notes }) {
  const checks = [
    ['buyerName', buyerName, 100, false],
    ['buyerPhone', buyerPhone, 30, true],
    ['address', address, 300, true],
    ['payment', payment, 60, false],
    ['size', size, 50, false],
    ['color', color, 50, false],
    ['notes', notes, 500, false]
  ];
  for (const [field, value, max, required] of checks) {
    if (value === undefined || value === null || value === '') {
      if (required) return `Campo "${field}" obrigatório.`;
      continue;
    }
    if (typeof value !== 'string') return `Campo "${field}" inválido.`;
    if (value.trim().length > max) return `Campo "${field}" demasiado longo (máx. ${max} caracteres).`;
  }
  if (buyerPhone && !PHONE_RE.test(buyerPhone)) return 'Número de telefone inválido.';
  return null;
}

module.exports = { normalizeOrderItems, validateOrderText, MAX_ITEMS, MAX_QTY_PER_ITEM };
