// Regressão: depois de a encomenda ser gravada, os alertas de stock liam `l.product.stock`, mas as linhas
// devolvidas por buildCheckout já não trazem `product` -> TypeError -> 500 com a compra JÁ feita.
// BD e serviços simulados (sem Prisma/Postgres).
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');
const root = process.cwd();

const pushed = [];
const logged = [];
const product = { id: 'p1', stock: 4, name: 'Camisola' };
const checkout = {
  paymentMode: 'ENTREGA',
  totals: { total: 100, payNow: 0 },
  groups: [{
    sellerId: 's1', bazar: { id: 'b1' }, subtotal: 100, discount: 0, shippingFee: 0, feeRate: 2, feeAmount: 2, total: 100,
    delivery: null, coupon: null, installments: null,
    // exactamente como o checkoutService devolve: linhas SEM `product`
    lines: [{ productId: 'p1', name: 'Camisola', qty: 2, unitPrice: 50, listPrice: 50, onSale: false, imageUrl: null }],
    _internal: { coupon: null, plan: null, bazar: { id: 'b1' }, products: [product] }
  }]
};
const tx = {
  order: { create: async ({ data }) => ({ id: 'o1', sellerId: data.sellerId, total: data.total, items: [{ name: 'Camisola' }] }) },
  orderStatusHistory: { create: async () => ({}) },
  product: { updateMany: async () => ({ count: 1 }) }
};
const prisma = { $transaction: async (fn) => fn(tx), user: { findUnique: async () => ({ email: null }) } };

const stubs = {
  '../utils/helpers': { paginate: () => ({}), paginateMeta: () => ({}), calcFee: () => 0, parseLatLng: () => null, sanitize: (v) => v },
  'express-validator': { validationResult: () => ({ isEmpty: () => true, array: () => [] }) },
  '../config/database': prisma,
  '../services/notificationService': { orderReceived() {}, shouldEmail: async () => false, push: (id, n) => pushed.push({ id, ...n }) },
  '../services/eventBus': {}, '../services/emailService': {}, '../services/premiumService': {}, '../services/auditService': {},
  '../services/blockService': { blockedAmong: async () => [] },
  '../services/checkoutService': { buildCheckout: async () => checkout, publicQuote: (c) => ({ paymentMode: c.paymentMode }) },
  '../services/couponService': {}, '../services/installmentService': {}, '../services/walletFlowService': {},
  '../utils/logger': { error: (m) => logged.push(['error', m]), warn() {}, info() {} }
};
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (stubs[req] && parent && /orderController/.test(parent.filename)) return stubs[req];
  return orig.call(this, req, parent, ...r);
};
const ctrl = require(path.join(root, 'src/controllers/orderController.js'));

test('placeOrder responde 201 e alerta stock baixo mesmo sem `product` nas linhas', async () => {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  const req = {
    id: 'r1', user: { id: 'u1', name: 'Ana' },
    body: { items: [{ productId: 'p1', qty: 2 }], buyerPhone: '840000000', address: 'Rua X' }
  };
  await ctrl.placeOrder(req, res);
  assert.strictEqual(out.code, 201, JSON.stringify(logged));
  assert.deepStrictEqual(logged, []);
  // stock 4 -> 2: cruza o limiar (3) -> "Stock baixo" para o vendedor
  assert.ok(pushed.some((n) => n.id === 's1' && n.title === 'Stock baixo'));
});
