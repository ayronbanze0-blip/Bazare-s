'use strict';

/**
 * Checkout — ÚNICA fonte de verdade do que o comprador paga.
 *   POST /checkout/quote  → mostra o cálculo (nada é gravado)
 *   POST /orders          → grava as encomendas a partir do MESMO cálculo
 * O cliente envia só intenções (itens, código de cupão, zona, forma de pagamento); preços, descontos,
 * entrega, juros e total são SEMPRE calculados aqui, no servidor.
 */
const prisma = require('../config/database');
const R = require('./pricingRules');
const IR = require('./installmentRules');
const couponSvc = require('./couponService');
const installmentSvc = require('./installmentService');
const premiumService = require('./premiumService');
const { blockedAmong } = require('./blockService');
const { AppError, bad, forbiddenErr } = require('../utils/appError');

const PAYMENT_MODES = ['ENTREGA', 'CARTEIRA', 'PARCELAS'];
const c2m = R.fromCents;

/**
 * @param {object} p
 * @param {string} p.buyerId
 * @param {{productId:string, qty:number}[]} p.items   já normalizados (normalizeOrderItems)
 * @param {string} [p.couponCode]
 * @param {string|Object<string,string>} [p.deliveryZones]  id da zona (carrinho de 1 vendedor) ou { [sellerId]: zoneId }
 * @param {'ENTREGA'|'CARTEIRA'|'PARCELAS'} [p.paymentMode]
 * @param {number} [p.installments]  nº de parcelas (PARCELAS)
 */
async function buildCheckout({ buyerId, items, couponCode, deliveryZones, paymentMode = 'ENTREGA', installments, now = new Date() }) {
  const mode = String(paymentMode || 'ENTREGA').toUpperCase();
  if (!PAYMENT_MODES.includes(mode)) throw bad(`Forma de pagamento inválida. Use: ${PAYMENT_MODES.join(', ')}.`, 'PAYMENT_MODE_INVALID');

  // ─── Produtos ────────────────────────────────────────────────
  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, active: true, bazar: { active: true } },
    include: { bazar: true, images: { take: 1, orderBy: { order: 'asc' } } }
  });
  if (products.length !== productIds.length) throw bad('Um ou mais produtos não estão disponíveis.', 'PRODUCT_UNAVAILABLE');
  if (products.some((p) => p.sellerId === buyerId)) throw forbiddenErr('Não podes comprar os teus próprios produtos.', 'OWN_PRODUCT');

  const sellerIds = [...new Set(products.map((p) => p.sellerId))];
  const blocked = await blockedAmong(buyerId, sellerIds);
  // Mensagem genérica: não revela quem bloqueou quem.
  if (blocked.length) throw forbiddenErr('Não é possível encomendar a este vendedor.', 'SELLER_BLOCKED');

  const byId = new Map(products.map((p) => [p.id, p]));
  for (const it of items) {
    const p = byId.get(it.productId);
    if (p.stock < it.qty) throw new AppError(`Stock insuficiente para: ${p.name}`, 400, 'PRODUCT_OUT_OF_STOCK', { productId: p.id, available: p.stock });
  }

  // ─── Preços (promoções em vigor) ─────────────────────────────
  const promos = await couponSvc.livePromotions(productIds, now);

  const groupsMap = new Map();
  for (const it of items) {
    const p = byId.get(it.productId);
    const e = R.effectivePrice(p, promos.get(p.id), now);
    if (!groupsMap.has(p.sellerId)) groupsMap.set(p.sellerId, { sellerId: p.sellerId, bazar: p.bazar, lines: [] });
    groupsMap.get(p.sellerId).lines.push({
      productId: p.id, name: p.name, qty: it.qty, unitPrice: e.unitPrice, listPrice: e.listPrice, onSale: e.onSale,
      imageUrl: p.images?.[0]?.url || null, product: p
    });
  }
  const groups = [...groupsMap.values()];

  // ─── Cupão (um por compra; só desconta os artigos do vendedor que o criou) ───
  let coupon = null;
  let couponGroup = null;
  let couponEval = null;
  const code = R.normalizeCode(couponCode);
  if (couponCode !== undefined && couponCode !== null && String(couponCode).trim() !== '') {
    coupon = await prisma.coupon.findUnique({ where: { code } });
    // Mesmo erro para "não existe" e "não é destes vendedores" — não revela cupões de outros.
    if (!coupon) throw bad('Cupão inválido ou desactivado.', 'COUPON_INVALID');
    couponGroup = groups.find((g) => g.sellerId === coupon.sellerId);
    if (!couponGroup) throw bad('Este cupão não se aplica aos artigos do carrinho.', 'COUPON_NOT_APPLICABLE');
    const [buyerUsedCount, priorOrders] = await Promise.all([
      prisma.couponRedemption.count({ where: { couponId: coupon.id, userId: buyerId, status: 'APPLIED' } }),
      coupon.firstOrderOnly ? prisma.order.count({ where: { buyerId, status: { not: 'CANCELADA' } } }) : Promise.resolve(0)
    ]);
    couponEval = R.evaluateCoupon({
      coupon, lines: couponGroup.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice, qty: l.qty })),
      now, buyerUsedCount, buyerHasPriorOrders: priorOrders > 0
    });
  }

  // ─── Entrega (por vendedor) ──────────────────────────────────
  const zones = await prisma.deliveryZone.findMany({ where: { bazarId: { in: groups.map((g) => g.bazar.id) }, active: true }, orderBy: { fee: 'asc' } });
  const zonesByBazar = new Map();
  for (const z of zones) {
    if (!zonesByBazar.has(z.bazarId)) zonesByBazar.set(z.bazarId, []);
    zonesByBazar.get(z.bazarId).push(z);
  }
  const wantedZone = (sellerId) => {
    if (typeof deliveryZones === 'string') return groups.length === 1 ? deliveryZones : null;
    if (deliveryZones && typeof deliveryZones === 'object') return deliveryZones[sellerId] || null;
    return null;
  };

  // ─── Parcelas / carteira ─────────────────────────────────────
  let settings = new Map();
  const count = installments === undefined || installments === null || installments === '' ? null : Number(installments);
  if (mode === 'PARCELAS') {
    if (!Number.isInteger(count)) throw bad('Indica o número de parcelas.', 'INSTALLMENT_BAD_COUNT');
    await installmentSvc.assertBuyerEligible(buyerId);
    settings = await installmentSvc.publicSettingsFor(sellerIds);
  }

  // ─── Totais por vendedor (em cêntimos) ───────────────────────
  let grandSubtotal = 0; let grandDiscount = 0; let grandShipping = 0; let grandTotal = 0; let grandPromoSavings = 0; let payNow = 0; let grandInterest = 0;
  const outGroups = [];

  for (const g of groups) {
    const subtotalC = g.lines.reduce((s, l) => s + R.toCents(l.unitPrice) * l.qty, 0);
    const listC = g.lines.reduce((s, l) => s + R.toCents(l.listPrice) * l.qty, 0);
    const discountC = couponGroup === g ? R.toCents(couponEval.discount) : 0;

    const bazarZones = zonesByBazar.get(g.bazar.id) || [];
    let zone = null;
    if (bazarZones.length > 0) {
      const wanted = wantedZone(g.sellerId);
      if (!wanted) throw new AppError(`Escolhe a zona de entrega para "${g.bazar.name}".`, 400, 'DELIVERY_ZONE_REQUIRED', { bazarId: g.bazar.id });
      zone = bazarZones.find((z) => z.id === wanted);
      if (!zone) throw new AppError(`Zona de entrega inválida para "${g.bazar.name}".`, 400, 'DELIVERY_ZONE_INVALID', { bazarId: g.bazar.id });
    }
    const shippingC = R.toCents(R.shippingFor(zone, c2m(subtotalC - discountC)));
    const totalC = subtotalC - discountC + shippingC;

    // Comissão: sobre os artigos (após desconto), nunca sobre a entrega
    const sellerPremium = await isPremiumSeller(g.sellerId, now);
    const feeRate = premiumService.effectiveFeeRate(g.bazar.feeRate || 2, sellerPremium);
    const feeAmount = Math.round(((subtotalC - discountC) * (feeRate / 100))) / 100;

    let plan = null;
    let payNowC = 0;
    if (mode === 'CARTEIRA') {
      payNowC = totalC;
    } else if (mode === 'PARCELAS') {
      const setting = settings.get(g.sellerId) || null;
      IR.assertPlanAllowed(setting, { total: c2m(totalC), count, sellerName: `"${g.bazar.name}"` });
      const schedule = IR.buildSchedule({ total: c2m(totalC), downPaymentPct: setting.downPaymentPct, count, interestPct: setting.interestPct, frequencyDays: setting.frequencyDays, now });
      plan = { count, setting, schedule };
      payNowC = R.toCents(schedule.down);
      grandInterest += R.toCents(schedule.interest);
    }

    grandSubtotal += subtotalC; grandDiscount += discountC; grandShipping += shippingC; grandTotal += totalC;
    grandPromoSavings += listC - subtotalC; payNow += payNowC;

    outGroups.push({
      sellerId: g.sellerId,
      bazar: { id: g.bazar.id, name: g.bazar.name, slug: g.bazar.slug },
      lines: g.lines.map(({ product, ...l }) => l),
      listSubtotal: c2m(listC), promoSavings: c2m(listC - subtotalC),
      subtotal: c2m(subtotalC),
      coupon: couponGroup === g ? { id: coupon.id, code: coupon.code, discount: c2m(discountC), type: coupon.type } : null,
      discount: c2m(discountC),
      delivery: zone ? { zoneId: zone.id, name: zone.name, etaDays: zone.etaDays, fee: c2m(shippingC), free: shippingC === 0 && R.toCents(zone.fee) > 0 } : null,
      shippingFee: c2m(shippingC),
      total: c2m(totalC),
      feeRate, feeAmount,
      installments: plan ? {
        count: plan.count, frequencyDays: plan.setting.frequencyDays, interestPct: plan.setting.interestPct,
        downPayment: plan.schedule.down, interest: plan.schedule.interest, totalPayable: plan.schedule.totalPayable,
        schedule: plan.schedule.parcels.map((p) => ({ number: p.number, amount: p.amount, dueDate: p.dueDate }))
      } : null,
      payNow: c2m(payNowC),
      // uso interno (placeOrder) — removido por publicQuote()
      _internal: { coupon: couponGroup === g ? coupon : null, plan, bazar: g.bazar, products: g.lines.map((l) => l.product) }
    });
  }

  return {
    paymentMode: mode,
    groups: outGroups,
    totals: {
      listSubtotal: c2m(grandSubtotal + grandPromoSavings), promoSavings: c2m(grandPromoSavings),
      subtotal: c2m(grandSubtotal), discount: c2m(grandDiscount), shipping: c2m(grandShipping),
      interest: c2m(grandInterest), total: c2m(grandTotal),
      totalPayable: c2m(grandTotal + grandInterest), payNow: c2m(payNow),
      totalSavings: c2m(grandPromoSavings + grandDiscount)
    }
  };
}

const isPremiumSeller = async (sellerId, now) => {
  const u = await prisma.user.findUnique({ where: { id: sellerId }, select: { isPremium: true, premiumExpiresAt: true } });
  return Boolean(u && u.isPremium && u.premiumExpiresAt && new Date(u.premiumExpiresAt) > now);
};

/** Versão segura para a resposta HTTP (sem campos internos). */
function publicQuote(checkout, extra = {}) {
  return {
    paymentMode: checkout.paymentMode,
    groups: checkout.groups.map(({ _internal, feeRate, feeAmount, ...g }) => g),
    totals: checkout.totals,
    ...extra
  };
}

/** Condições de pagamento (parcelas) dos vendedores do carrinho — para o ecrã de checkout mostrar as opções. */
async function paymentOptions(buyerId, items) {
  const products = await prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) }, active: true }, select: { sellerId: true, bazar: { select: { id: true, name: true } } } });
  const sellerIds = [...new Set(products.map((p) => p.sellerId))];
  const settings = await installmentSvc.publicSettingsFor(sellerIds);
  const wallet = await prisma.wallet.findUnique({ where: { userId: buyerId }, select: { balance: true, pinHash: true } });
  let blockedReason = null;
  try { await installmentSvc.assertBuyerEligible(buyerId); } catch (e) { blockedReason = e.message; }
  const sellers = sellerIds.map((sid) => {
    const s = settings.get(sid);
    const p = products.find((x) => x.sellerId === sid);
    return { sellerId: sid, bazarName: p?.bazar?.name || null, installments: s ? { maxInstallments: s.maxInstallments, minOrderAmount: s.minOrderAmount, downPaymentPct: s.downPaymentPct, interestPct: s.interestPct, frequencyDays: s.frequencyDays } : null };
  });
  return {
    walletBalance: wallet ? wallet.balance : 0,
    hasPin: Boolean(wallet && wallet.pinHash),
    modes: {
      ENTREGA: true, CARTEIRA: true,
      PARCELAS: !blockedReason && sellers.every((s) => s.installments)
    },
    installmentsBlockedReason: blockedReason,
    sellers
  };
}

module.exports = { PAYMENT_MODES, buildCheckout, publicQuote, paymentOptions };
