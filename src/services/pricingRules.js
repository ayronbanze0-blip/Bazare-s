'use strict';

/**
 * Regras PURAS de preço, descontos e entrega (sem BD — testáveis com `node --test`).
 * Todo o cálculo é feito em CÊNTIMOS (inteiros) para nunca acumular erros de vírgula flutuante.
 * Quem precisa de dados (produtos, cupão, zona) carrega-os e passa-os para aqui.
 */
const { AppError } = require('../utils/appError');
const V = require('../utils/validate');

const MAX_PERCENT = 90;            // um cupão em % nunca passa de 90%
const MAX_DISCOUNT_RATIO = 0.9;    // nenhum desconto (cupão) pode ultrapassar 90% dos artigos elegíveis → total nunca é 0
const MAX_PROMO_DAYS = 90;
const CODE_RE = /^[A-Z0-9_-]{3,24}$/;

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

const normalizeCode = (raw) => (typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : '');

// ─── Promoções ────────────────────────────────────────────────────
/** A promoção está em vigor agora? (activa, começou, não terminou) */
function promoIsLive(promo, now = new Date()) {
  if (!promo || promo.active === false) return false;
  const t = now.getTime();
  if (promo.startsAt && new Date(promo.startsAt).getTime() > t) return false;
  if (promo.endsAt && new Date(promo.endsAt).getTime() <= t) return false;
  return Number(promo.salePrice) > 0 && Number(promo.salePrice) < Number(promo.originalPrice ?? Infinity);
}

/**
 * Preço efectivo de um produto. A promoção só vale se salePrice < preço de tabela ACTUAL
 * (se o vendedor baixou o preço de tabela abaixo da promoção, ganha o mais baixo).
 * @returns {{ unitPrice:number, listPrice:number, onSale:boolean, discountPercent:number }}
 */
function effectivePrice(product, promo, now = new Date()) {
  const list = Number(product.price);
  if (promoIsLive(promo, now) && Number(promo.salePrice) < list) {
    const sale = Number(promo.salePrice);
    return { unitPrice: sale, listPrice: list, onSale: true, discountPercent: Math.round(((list - sale) / list) * 100) };
  }
  return { unitPrice: list, listPrice: list, onSale: false, discountPercent: 0 };
}

/** Valida o corpo de criação/edição de uma promoção. `listPrice` = preço actual do produto. */
function parsePromotionInput(body, listPrice, now = new Date()) {
  V.bodyObject(body);
  const salePrice = V.money(body.salePrice, 'salePrice', { min: 0.01, max: 1e9 });
  if (salePrice >= listPrice) throw new AppError('O preço promocional tem de ser inferior ao preço actual do produto.', 400, 'PROMO_PRICE_TOO_HIGH');
  if (salePrice < listPrice * 0.05) throw new AppError('Desconto demasiado grande (máx. 95%).', 400, 'PROMO_DISCOUNT_TOO_LARGE');
  const startsAt = body.startsAt ? V.date(body.startsAt, 'startsAt') : now;
  const endsAt = V.date(body.endsAt, 'endsAt');
  if (endsAt <= startsAt) throw new AppError('A data de fim tem de ser depois da data de início.', 400, 'PROMO_BAD_DATES');
  if (endsAt <= now) throw new AppError('A data de fim já passou.', 400, 'PROMO_BAD_DATES');
  if (endsAt.getTime() - startsAt.getTime() > MAX_PROMO_DAYS * 86400000) throw new AppError(`Uma promoção dura no máximo ${MAX_PROMO_DAYS} dias.`, 400, 'PROMO_TOO_LONG');
  const label = V.text(body.label, 'label', { max: 40, required: false });
  return { salePrice, startsAt, endsAt, label };
}

// ─── Cupões ───────────────────────────────────────────────────────
/** Valida o corpo de criação de um cupão. */
function parseCouponInput(body, { partial = false } = {}) {
  V.bodyObject(body);
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('code')) {
    const code = normalizeCode(body.code);
    if (!CODE_RE.test(code)) throw new AppError('Código inválido: 3 a 24 caracteres (letras, números, "-" ou "_").', 400, 'COUPON_BAD_CODE');
    out.code = code;
  }
  if (!partial || has('type')) out.type = V.oneOf(body.type, 'type', ['PERCENT', 'FIXED']);
  if (!partial || has('value')) {
    const type = out.type || body.type;
    const value = V.money(body.value, 'value', { min: 0.01 });
    if (type === 'PERCENT' && value > MAX_PERCENT) throw new AppError(`Desconto em % no máximo ${MAX_PERCENT}.`, 400, 'COUPON_BAD_VALUE');
    out.value = value;
  }
  if (has('description')) out.description = V.text(body.description, 'description', { max: 120, required: false });
  if (has('minOrderAmount')) out.minOrderAmount = V.money(body.minOrderAmount, 'minOrderAmount', { min: 0, def: 0 });
  if (has('maxDiscount')) out.maxDiscount = body.maxDiscount === null ? null : V.money(body.maxDiscount, 'maxDiscount', { min: 0.01, required: false });
  if (has('usageLimit')) out.usageLimit = body.usageLimit === null ? null : V.int(body.usageLimit, 'usageLimit', { min: 1, max: 1e6, required: false });
  if (has('perUserLimit')) out.perUserLimit = V.int(body.perUserLimit, 'perUserLimit', { min: 1, max: 100, def: 1 });
  if (has('firstOrderOnly')) out.firstOrderOnly = V.bool(body.firstOrderOnly, 'firstOrderOnly', { def: false });
  if (has('productIds')) out.productIds = V.idList(body.productIds, 'productIds', { max: 100 });
  if (has('startsAt')) out.startsAt = body.startsAt === null ? null : V.date(body.startsAt, 'startsAt', { required: false });
  if (has('expiresAt')) out.expiresAt = body.expiresAt === null ? null : V.date(body.expiresAt, 'expiresAt', { required: false });
  if (has('active')) out.active = V.bool(body.active, 'active', { def: true });

  if (out.startsAt && out.expiresAt && out.expiresAt <= out.startsAt) throw new AppError('A validade tem de ser depois do início.', 400, 'COUPON_BAD_DATES');
  if (!partial && out.expiresAt && out.expiresAt <= new Date()) throw new AppError('A validade já passou.', 400, 'COUPON_BAD_DATES');
  return out;
}

/**
 * Avalia um cupão sobre as linhas de UM vendedor. Lança AppError com código estável se não puder ser usado.
 * @param {object} p
 * @param {object} p.coupon
 * @param {{productId:string, unitPrice:number, qty:number}[]} p.lines linhas do vendedor dono do cupão
 * @param {number} p.buyerUsedCount utilizações APPLIED deste comprador
 * @param {boolean} p.buyerHasPriorOrders já tem compras (não canceladas) na plataforma
 * @returns {{ discount:number, eligibleSubtotal:number }} (em MT)
 */
function evaluateCoupon({ coupon, lines, now = new Date(), buyerUsedCount = 0, buyerHasPriorOrders = false }) {
  if (!coupon || coupon.active === false) throw new AppError('Cupão inválido ou desactivado.', 400, 'COUPON_INVALID');
  if (coupon.startsAt && new Date(coupon.startsAt) > now) throw new AppError('Este cupão ainda não está activo.', 400, 'COUPON_NOT_STARTED');
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) throw new AppError('Este cupão expirou.', 400, 'COUPON_EXPIRED');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw new AppError('Este cupão já esgotou.', 400, 'COUPON_EXHAUSTED');
  if (buyerUsedCount >= (coupon.perUserLimit || 1)) throw new AppError('Já utilizaste este cupão o número máximo de vezes.', 400, 'COUPON_ALREADY_USED');
  if (coupon.firstOrderOnly && buyerHasPriorOrders) throw new AppError('Este cupão é só para a primeira compra.', 400, 'COUPON_FIRST_ORDER_ONLY');

  const scoped = Array.isArray(coupon.productIds) && coupon.productIds.length > 0;
  const eligible = lines.filter((l) => !scoped || coupon.productIds.includes(l.productId));
  if (eligible.length === 0) throw new AppError('Este cupão não se aplica aos artigos do carrinho.', 400, 'COUPON_NOT_APPLICABLE');

  const eligibleCents = eligible.reduce((s, l) => s + toCents(l.unitPrice) * l.qty, 0);
  if (coupon.minOrderAmount && eligibleCents < toCents(coupon.minOrderAmount)) {
    throw new AppError(`Compra mínima para este cupão: ${Number(coupon.minOrderAmount).toLocaleString('pt-MZ')} MT.`, 400, 'COUPON_MIN_ORDER', { minOrderAmount: coupon.minOrderAmount });
  }

  let discountCents;
  if (coupon.type === 'PERCENT') discountCents = Math.round((eligibleCents * Number(coupon.value)) / 100);
  else discountCents = toCents(coupon.value);
  if (coupon.maxDiscount != null) discountCents = Math.min(discountCents, toCents(coupon.maxDiscount));
  discountCents = Math.min(discountCents, Math.floor(eligibleCents * MAX_DISCOUNT_RATIO));
  if (discountCents <= 0) throw new AppError('Este cupão não gera desconto nesta compra.', 400, 'COUPON_NO_DISCOUNT');

  return { discount: fromCents(discountCents), eligibleSubtotal: fromCents(eligibleCents) };
}

// ─── Entrega ──────────────────────────────────────────────────────
/** Taxa de entrega de uma zona para um valor (já com descontos). Grátis se atingir `freeAbove`. */
function shippingFor(zone, amountAfterDiscount) {
  if (!zone) return 0;
  const fee = toCents(zone.fee || 0);
  if (zone.freeAbove != null && toCents(amountAfterDiscount) >= toCents(zone.freeAbove)) return 0;
  return fromCents(fee);
}

function parseZoneInput(body, { partial = false } = {}) {
  V.bodyObject(body);
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) out.name = V.text(body.name, 'name', { max: 60 });
  if (!partial || has('fee')) out.fee = V.money(body.fee, 'fee', { min: 0, max: 100000, def: 0 });
  if (has('freeAbove')) out.freeAbove = body.freeAbove === null ? null : V.money(body.freeAbove, 'freeAbove', { min: 0.01, required: false });
  if (has('etaDays')) out.etaDays = body.etaDays === null ? null : V.int(body.etaDays, 'etaDays', { min: 0, max: 60, required: false });
  if (has('active')) out.active = V.bool(body.active, 'active', { def: true });
  return out;
}

module.exports = {
  MAX_PERCENT, MAX_DISCOUNT_RATIO, MAX_PROMO_DAYS,
  toCents, fromCents, normalizeCode,
  promoIsLive, effectivePrice, parsePromotionInput,
  parseCouponInput, evaluateCoupon,
  shippingFor, parseZoneInput
};
