'use strict';

/**
 * Comércio: checkout (cotação), cupões, promoções/ofertas, parcelas, zonas de entrega, moradas e extras de encomenda.
 * Todas as regras vivem nos serviços — aqui só há validação de entrada, autorização e resposta.
 */
const prisma = require('../config/database');
const { ok, created } = require('../utils/response');
const { handle, bad, notFoundErr, forbiddenErr, replyKnown } = require('../utils/appError');
const V = require('../utils/validate');
const R = require('../services/pricingRules');
const couponSvc = require('../services/couponService');
const installmentSvc = require('../services/installmentService');
const checkoutSvc = require('../services/checkoutService');
const walletFlow = require('../services/walletFlowService');
const { normalizeOrderItems } = require('../utils/orderItems');
const { paginate, paginateMeta } = require('../utils/helpers');

const MAX_ADDRESSES = 10;
const MAX_ZONES = 20;

// ═════════════════════════════════════════════════════════════════
// Checkout
// ═════════════════════════════════════════════════════════════════
const quote = handle('Checkout.quote', async (req, res) => {
  V.bodyObject(req.body);
  const normalized = normalizeOrderItems(req.body.items);
  if (normalized.error) throw bad(normalized.error, 'VALIDATION_ERROR');
  const checkout = await checkoutSvc.buildCheckout({
    buyerId: req.user.id, items: normalized.items, couponCode: req.body.couponCode,
    deliveryZones: req.body.deliveryZones !== undefined ? req.body.deliveryZones : req.body.deliveryZoneId,
    paymentMode: req.body.paymentMode, installments: req.body.installments
  });
  const wallet = checkout.paymentMode === 'ENTREGA' ? null : await prisma.wallet.findUnique({ where: { userId: req.user.id }, select: { balance: true } });
  const balance = wallet ? wallet.balance : null;
  return ok(res, checkoutSvc.publicQuote(checkout, {
    wallet: balance === null ? null : { balance, enough: balance + 1e-9 >= checkout.totals.payNow, missing: Math.max(0, R.fromCents(R.toCents(checkout.totals.payNow) - R.toCents(balance))) }
  }));
});

const paymentOptions = handle('Checkout.paymentOptions', async (req, res) => {
  const normalized = normalizeOrderItems(req.body && req.body.items);
  if (normalized.error) throw bad(normalized.error, 'VALIDATION_ERROR');
  return ok(res, await checkoutSvc.paymentOptions(req.user.id, normalized.items));
});

// ═════════════════════════════════════════════════════════════════
// Cupões (vendedor) + admin
// ═════════════════════════════════════════════════════════════════
const couponCreate = handle('Coupons.create', async (req, res) => created(res, { coupon: await couponSvc.createCoupon(req.user.id, req.body) }, 'Cupão criado.'));
const couponList = handle('Coupons.list', async (req, res) => ok(res, await couponSvc.listCoupons(req.user.id, req.query)));
const couponUpdate = handle('Coupons.update', async (req, res) => ok(res, { coupon: await couponSvc.updateCoupon(req.user, req.params.id, V.bodyObject(req.body)) }, 'Cupão actualizado.'));
const couponDelete = handle('Coupons.delete', async (req, res) => {
  const r = await couponSvc.deleteCoupon(req.user, req.params.id);
  return ok(res, r, r.deleted ? 'Cupão apagado.' : 'O cupão já foi usado — ficou desactivado.');
});
const couponRedemptions = handle('Coupons.redemptions', async (req, res) => ok(res, await couponSvc.couponRedemptions(req.user, req.params.id, req.query)));

/** Comprador: testar um código ANTES do checkout (o desconto real é sempre recalculado no pedido). */
const couponValidate = handle('Coupons.validate', async (req, res) => {
  V.bodyObject(req.body);
  const normalized = normalizeOrderItems(req.body.items);
  if (normalized.error) throw bad(normalized.error, 'VALIDATION_ERROR');
  if (!R.normalizeCode(req.body.code)) throw bad('Indica o código do cupão.', 'VALIDATION_ERROR');
  const checkout = await checkoutSvc.buildCheckout({ buyerId: req.user.id, items: normalized.items, couponCode: req.body.code });
  const g = checkout.groups.find((x) => x.coupon);
  return ok(res, { valid: true, coupon: g.coupon, discount: g.discount, totalAfter: g.total, bazar: g.bazar }, 'Cupão válido.');
});

const adminCouponList = handle('Admin.coupons', async (req, res) => {
  const { skip, take } = paginate(req.query.page, req.query.limit);
  const where = { ...(req.query.sellerId && { sellerId: String(req.query.sellerId) }), ...(req.query.q && { code: { contains: R.normalizeCode(req.query.q) } }) };
  const [rows, total] = await Promise.all([
    prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { seller: { select: { id: true, name: true } } } }),
    prisma.coupon.count({ where })
  ]);
  return ok(res, { coupons: rows.map((c) => ({ ...couponSvc.publicCoupon(c), seller: c.seller })), meta: paginateMeta(total, req.query.page, req.query.limit) });
});
const adminCouponDisable = handle('Admin.couponDisable', async (req, res) => {
  const r = await prisma.coupon.updateMany({ where: { id: req.params.id }, data: { active: false } });
  if (!r.count) throw notFoundErr('Cupão não encontrado.');
  return ok(res, { disabled: true }, 'Cupão desactivado.');
});

// ═════════════════════════════════════════════════════════════════
// Promoções e ofertas
// ═════════════════════════════════════════════════════════════════
const promoUpsert = handle('Promotions.upsert', async (req, res) => created(res, { promotion: await couponSvc.upsertPromotion(req.user.id, V.id(req.params.productId, 'productId'), req.body) }, 'Promoção guardada.'));
const promoEnd = handle('Promotions.end', async (req, res) => ok(res, await couponSvc.endPromotion(req.user.id, V.id(req.params.productId, 'productId')), 'Promoção terminada.'));
const promoList = handle('Promotions.list', async (req, res) => ok(res, await couponSvc.listPromotions(req.user.id, req.query)));
const deals = handle('Promotions.deals', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  return ok(res, await couponSvc.publicDeals(req.query, req.user ? req.user.id : null));
});

// ═════════════════════════════════════════════════════════════════
// Parcelas
// ═════════════════════════════════════════════════════════════════
const settingsGet = handle('Installments.settingsGet', async (req, res) => ok(res, { settings: await installmentSvc.getSettings(req.user.id) }));
const settingsPut = handle('Installments.settingsPut', async (req, res) => ok(res, { settings: await installmentSvc.saveSettings(req.user.id, req.body) }, 'Condições guardadas.'));
const plansMine = handle('Installments.mine', async (req, res) => ok(res, await installmentSvc.listPlans(req.user.id, { as: 'buyer', ...req.query })));
const plansReceived = handle('Installments.received', async (req, res) => ok(res, await installmentSvc.listPlans(req.user.id, { as: 'seller', ...req.query })));
const planOne = handle('Installments.one', async (req, res) => ok(res, { plan: await installmentSvc.getPlan(req.user, V.id(req.params.id)) }));
const upcoming = handle('Installments.upcoming', async (req, res) => ok(res, await installmentSvc.upcomingForBuyer(req.user.id, { days: V.int(req.query.days, 'days', { min: 1, max: 365, def: 30 }) })));
const sellerInstallmentSummary = handle('Installments.sellerSummary', async (req, res) => ok(res, await installmentSvc.sellerSummary(req.user.id)));

/** Pagar a próxima parcela (ou uma específica) — exige o PIN da carteira. */
const pay = handle('Installments.pay', async (req, res) => {
  V.bodyObject(req.body);
  const pin = typeof req.body.pin === 'string' ? req.body.pin : '';
  const all = V.bool(req.body.all, 'all', { def: false });
  const planId = req.params.planId ? V.id(req.params.planId, 'planId') : undefined;
  const installmentId = req.body.installmentId ? V.id(req.body.installmentId, 'installmentId') : undefined;
  const target = await installmentSvc.resolvePayTargets(req.user.id, { planId, installmentId, all });
  await walletFlow.verifyPin(req.user.id, pin);
  const result = await installmentSvc.settleInstallments(target.plan.id, target.ids, { actor: 'buyer' });
  return ok(res, result, result.planStatus === 'COMPLETED' ? 'Compra totalmente paga.' : 'Pagamento efectuado.');
});

const autoPayToggle = handle('Installments.autopay', async (req, res) => {
  V.bodyObject(req.body);
  const enabled = V.bool(req.body.enabled, 'enabled', { def: undefined });
  if (enabled === undefined) throw bad('"enabled" é obrigatório.', 'VALIDATION_ERROR');
  return ok(res, await installmentSvc.setAutoPay(req.user.id, V.id(req.params.planId, 'planId'), enabled));
});

/** Vendedor/admin: repetir um reembolso pendente (ex.: depois de carregar a carteira). */
const retryRefund = handle('Installments.retryRefund', async (req, res) => {
  const plan = await installmentSvc.getPlan(req.user, V.id(req.params.planId, 'planId'));
  if (plan.sellerId !== req.user.id && req.user.role !== 'ADMIN') throw forbiddenErr();
  const r = await installmentSvc.refundPlan(plan.id, { reason: 'reembolso pendente' });
  return ok(res, r, r.pending > 0 ? 'Ainda sem saldo suficiente.' : 'Reembolso efectuado.');
});

const adminInstallments = handle('Admin.installments', async (req, res) => ok(res, await installmentSvc.adminOverview()));

// ═════════════════════════════════════════════════════════════════
// Zonas de entrega
// ═════════════════════════════════════════════════════════════════
const myBazarId = async (userId) => {
  const b = await prisma.bazar.findUnique({ where: { sellerId: userId }, select: { id: true } });
  if (!b) throw bad('Cria primeiro o teu bazar.', 'NO_BAZAR');
  return b.id;
};

const zoneList = handle('Zones.list', async (req, res) => ok(res, { zones: await prisma.deliveryZone.findMany({ where: { bazarId: await myBazarId(req.user.id) }, orderBy: { createdAt: 'asc' } }) }));
const zoneCreate = handle('Zones.create', async (req, res) => {
  const bazarId = await myBazarId(req.user.id);
  const data = R.parseZoneInput(req.body);
  if ((await prisma.deliveryZone.count({ where: { bazarId } })) >= MAX_ZONES) throw bad(`Máximo de ${MAX_ZONES} zonas.`, 'ZONE_LIMIT');
  return created(res, { zone: await prisma.deliveryZone.create({ data: { ...data, bazarId } }) }, 'Zona criada.');
});
const zoneUpdate = handle('Zones.update', async (req, res) => {
  const bazarId = await myBazarId(req.user.id);
  const data = R.parseZoneInput(req.body, { partial: true });
  const r = await prisma.deliveryZone.updateMany({ where: { id: V.id(req.params.id), bazarId }, data });
  if (!r.count) throw notFoundErr('Zona não encontrada.');
  return ok(res, { zone: await prisma.deliveryZone.findUnique({ where: { id: req.params.id } }) }, 'Zona actualizada.');
});
const zoneDelete = handle('Zones.delete', async (req, res) => {
  const bazarId = await myBazarId(req.user.id);
  // Não se apaga: encomendas antigas guardam só o NOME da zona, por isso apagar é seguro
  const r = await prisma.deliveryZone.deleteMany({ where: { id: V.id(req.params.id), bazarId } });
  if (!r.count) throw notFoundErr('Zona não encontrada.');
  return ok(res, { deleted: true }, 'Zona removida.');
});
/** Público: zonas activas de um bazar (para o checkout) */
const zonesOfBazar = handle('Zones.public', async (req, res) => {
  const zones = await prisma.deliveryZone.findMany({ where: { bazarId: V.id(req.params.bazarId, 'bazarId'), active: true }, orderBy: { fee: 'asc' }, select: { id: true, name: true, fee: true, freeAbove: true, etaDays: true } });
  return ok(res, { zones });
});

// ═════════════════════════════════════════════════════════════════
// Livro de moradas
// ═════════════════════════════════════════════════════════════════
const parseAddress = (body, { partial = false } = {}) => {
  V.bodyObject(body);
  const has = (k) => body[k] !== undefined;
  const out = {};
  if (!partial || has('label')) out.label = V.text(body.label, 'label', { max: 30 });
  if (!partial || has('recipientName')) out.recipientName = V.text(body.recipientName, 'recipientName', { max: 80 });
  if (!partial || has('phone')) {
    const phone = V.text(body.phone, 'phone', { min: 7, max: 20 });
    if (!/^[+0-9()\-\s]{7,20}$/.test(phone)) throw bad('"phone" inválido.', 'VALIDATION_ERROR');
    out.phone = phone;
  }
  if (!partial || has('line')) out.line = V.text(body.line, 'line', { min: 5, max: 250 });
  if (has('city')) out.city = V.text(body.city, 'city', { max: 80, required: false });
  if (has('notes')) out.notes = V.text(body.notes, 'notes', { max: 200, required: false });
  if (has('latitude') || has('longitude')) {
    const lat = body.latitude === null ? null : Number(body.latitude);
    const lng = body.longitude === null ? null : Number(body.longitude);
    if ((lat === null) !== (lng === null)) throw bad('Indica latitude e longitude em conjunto.', 'VALIDATION_ERROR');
    if (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw bad('Coordenadas inválidas.', 'VALIDATION_ERROR');
    out.latitude = lat; out.longitude = lng;
  }
  if (has('isDefault')) out.isDefault = V.bool(body.isDefault, 'isDefault', { def: false });
  return out;
};

const addressList = handle('Addresses.list', async (req, res) => ok(res, { addresses: await prisma.address.findMany({ where: { userId: req.user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }) }));

const addressCreate = handle('Addresses.create', async (req, res) => {
  const data = parseAddress(req.body);
  const address = await prisma.$transaction(async (tx) => {
    // Serializa criações simultâneas do mesmo utilizador (limite de moradas e "uma só predefinida")
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'addr:' + req.user.id}))`;
    const count = await tx.address.count({ where: { userId: req.user.id } });
    if (count >= MAX_ADDRESSES) throw bad(`Máximo de ${MAX_ADDRESSES} moradas.`, 'ADDRESS_LIMIT');
    const makeDefault = data.isDefault === true || count === 0; // a primeira fica predefinida
    if (makeDefault) await tx.address.updateMany({ where: { userId: req.user.id, isDefault: true }, data: { isDefault: false } });
    return tx.address.create({ data: { ...data, isDefault: makeDefault, userId: req.user.id } });
  });
  return created(res, { address }, 'Morada guardada.');
});

const addressUpdate = handle('Addresses.update', async (req, res) => {
  const data = parseAddress(req.body, { partial: true });
  const id = V.id(req.params.id);
  const address = await prisma.$transaction(async (tx) => {
    const cur = await tx.address.findFirst({ where: { id, userId: req.user.id } });
    if (!cur) throw notFoundErr('Morada não encontrada.');
    if (data.isDefault === true) await tx.address.updateMany({ where: { userId: req.user.id, isDefault: true, id: { not: id } }, data: { isDefault: false } });
    if (data.isDefault === false && cur.isDefault) delete data.isDefault; // tem de haver sempre uma predefinida: escolhe-se outra para trocar
    return tx.address.update({ where: { id }, data });
  });
  return ok(res, { address }, 'Morada actualizada.');
});

const addressSetDefault = handle('Addresses.default', async (req, res) => {
  const id = V.id(req.params.id);
  const address = await prisma.$transaction(async (tx) => {
    const cur = await tx.address.findFirst({ where: { id, userId: req.user.id } });
    if (!cur) throw notFoundErr('Morada não encontrada.');
    await tx.address.updateMany({ where: { userId: req.user.id, isDefault: true }, data: { isDefault: false } });
    return tx.address.update({ where: { id }, data: { isDefault: true } });
  });
  return ok(res, { address }, 'Morada predefinida.');
});

const addressDelete = handle('Addresses.delete', async (req, res) => {
  const id = V.id(req.params.id);
  await prisma.$transaction(async (tx) => {
    const cur = await tx.address.findFirst({ where: { id, userId: req.user.id } });
    if (!cur) throw notFoundErr('Morada não encontrada.');
    await tx.address.delete({ where: { id } });
    if (cur.isDefault) { // promove a mais recente para predefinida
      const next = await tx.address.findFirst({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
  return ok(res, { deleted: true }, 'Morada removida.');
});

/**
 * Middleware de POST /orders: se vier `addressId`, preenche morada/telefone/nome/coordenadas a partir da
 * morada GUARDADA do próprio utilizador (nunca de outro) — assim o cliente pode enviar só o id.
 * Tem de correr ANTES da validação do pedido.
 */
const resolveAddressId = async (req, res, next) => {
  try {
    const id = req.body && req.body.addressId;
    if (id === undefined || id === null || id === '') return next();
    if (typeof id !== 'string' || id.length > 64) throw bad('"addressId" inválido.', 'VALIDATION_ERROR');
    const a = await prisma.address.findFirst({ where: { id, userId: req.user.id } });
    if (!a) throw notFoundErr('Morada não encontrada.');
    req.body.address = a.city ? `${a.line}, ${a.city}` : a.line;
    req.body.buyerPhone = a.phone;
    req.body.buyerName = a.recipientName;
    if (a.latitude !== null && a.longitude !== null) { req.body.latitude = a.latitude; req.body.longitude = a.longitude; }
    return next();
  } catch (err) {
    if (replyKnown(res, err)) return undefined;
    return next(err);
  }
};

// ═════════════════════════════════════════════════════════════════
// Extras de encomenda: cronologia, recibo, comprar de novo
// ═════════════════════════════════════════════════════════════════
const participantOrder = async (user, id, include) => {
  const order = await prisma.order.findUnique({ where: { id }, include });
  if (!order) throw notFoundErr('Encomenda não encontrada.');
  if (order.buyerId !== user.id && order.sellerId !== user.id && user.role !== 'ADMIN') throw forbiddenErr();
  return order;
};

const STATUS_LABELS = { PENDENTE: 'Encomenda feita', ACEITE: 'Aceite pelo vendedor', EM_PREPARACAO: 'Em preparação', EM_ENTREGA: 'A caminho', ENTREGUE: 'Entregue', CANCELADA: 'Cancelada' };

const orderTimeline = handle('Orders.timeline', async (req, res) => {
  const order = await participantOrder(req.user, V.id(req.params.id), { statusHistory: { orderBy: { createdAt: 'asc' } } });
  const timeline = order.statusHistory.map((h) => ({ status: h.status, label: STATUS_LABELS[h.status] || h.status, by: h.actorRole, note: h.note, at: h.createdAt }));
  return ok(res, { orderId: order.id, current: order.status, timeline });
});

const orderReceipt = handle('Orders.receipt', async (req, res) => {
  const order = await participantOrder(req.user, V.id(req.params.id), {
    items: true, bazar: { select: { id: true, name: true } },
    buyer: { select: { id: true, name: true } },
    installmentPlan: { include: { installments: { orderBy: { number: 'asc' } } } }
  });
  const items = order.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.price, originalPrice: i.originalPrice, lineTotal: V.round2(i.price * i.qty) }));
  return ok(res, {
    receipt: {
      number: order.id.slice(-8).toUpperCase(), orderId: order.id, issuedAt: new Date().toISOString(), orderedAt: order.createdAt, status: order.status,
      seller: order.bazar, buyer: { name: order.buyerName || order.buyer.name },
      items, subtotal: order.subtotal, discount: order.discountAmount, coupon: order.couponCode,
      shipping: order.shippingFee, deliveryZone: order.shippingZone, total: order.total,
      payment: { label: order.payment, mode: order.paymentMode, plan: order.installmentPlan ? {
        count: order.installmentPlan.count, totalAmount: order.installmentPlan.totalAmount, paidAmount: order.installmentPlan.paidAmount, status: order.installmentPlan.status,
        installments: order.installmentPlan.installments.map((i) => ({ number: i.number, amount: i.amount, lateFee: i.lateFee, dueDate: i.dueDate, status: i.status, paidAt: i.paidAt }))
      } : null }
    }
  });
});

const buyAgain = handle('Orders.buyAgain', async (req, res) => {
  const rows = await prisma.orderItem.findMany({
    where: { order: { buyerId: req.user.id, status: 'ENTREGUE' }, product: { active: true, stock: { gt: 0 }, bazar: { active: true } } },
    orderBy: { order: { deliveredAt: 'desc' } }, take: 60, distinct: ['productId'],
    select: { productId: true, qty: true, product: { include: { images: { take: 1, orderBy: { order: 'asc' } }, bazar: { select: { id: true, name: true, slug: true } } } } }
  });
  const products = await couponSvc.attachPromotions(rows.slice(0, 20).map((r) => ({ ...r.product, lastQty: r.qty })), { viewerId: req.user.id });
  return ok(res, { products });
});

module.exports = {
  quote, paymentOptions,
  couponCreate, couponList, couponUpdate, couponDelete, couponRedemptions, couponValidate, adminCouponList, adminCouponDisable,
  promoUpsert, promoEnd, promoList, deals,
  settingsGet, settingsPut, plansMine, plansReceived, planOne, upcoming, sellerInstallmentSummary, pay, autoPayToggle, retryRefund, adminInstallments,
  zoneList, zoneCreate, zoneUpdate, zoneDelete, zonesOfBazar,
  addressList, addressCreate, addressUpdate, addressSetDefault, addressDelete, resolveAddressId,
  orderTimeline, orderReceipt, buyAgain
};
