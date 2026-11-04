// Compra Segura com Código — fluxo completo com uma BD simulada em memória (sem Prisma/Postgres):
// aceitar → pagar (PIN, duplo toque, saldo) → código (só o comprador) → tentativas/bloqueio → libertar → reembolso.
process.env.JWT_ACCESS_SECRET = 'segredo-de-teste-segredo-de-teste-123456';
process.env.ESCROW_CODE_MAX_ATTEMPTS = '3';

const Module = require('module');
const path = require('path');
const assert = require('assert');
const { test, beforeEach } = require('node:test');
const root = process.cwd();

// ─── BD simulada ───────────────────────────────────────────────────────────
let db;
const reset = () => {
  db = {
    orders: { o1: mkOrder() },
    wallets: { buyer: { id: 'wb', userId: 'buyer', balance: 500 }, seller: { id: 'ws', userId: 'seller', balance: 0 } },
    walletTx: [], history: [], pushed: [], events: [], pinOk: true, disputes: [], bazarSales: 0, productSales: 0
  };
};
const mkOrder = () => ({
  id: 'o1', buyerId: 'buyer', sellerId: 'seller', bazarId: 'b1', status: 'PENDENTE', paymentMode: 'SEGURA',
  total: 200, subtotal: 200, discountAmount: 0, escrowState: null, escrowAmount: 0, codeNonce: null,
  codeAttempts: 0, codeLockedUntil: null, payDeadline: null, deliveryDeadline: null, acceptedAt: null, paidAt: null, feeAmount: 0
});
const matches = (o, w = {}) => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return v.some((c) => matches(o, c));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(o[k]);
    if ('lt' in v) return o[k] !== null && o[k] < v.lt;
    if ('lte' in v) return o[k] !== null && o[k] <= v.lte;
    if ('gte' in v) return o[k] >= v.gte;
  }
  return (o[k] === undefined ? null : o[k]) === v;
});
const apply = (o, data) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) o[k] = (o[k] || 0) + v.increment;
    else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v) o[k] = (o[k] || 0) - v.decrement;
    else o[k] = v;
  }
};
const walletOf = (userId) => db.wallets[userId] || (db.wallets[userId] = { id: 'w' + userId, userId, balance: 0 });

const tx = {
  order: {
    findUnique: async ({ where }) => (db.orders[where.id] ? { ...db.orders[where.id] } : null),
    updateMany: async ({ where, data }) => {
      const hit = Object.values(db.orders).filter((o) => matches(o, where));
      hit.forEach((o) => apply(o, data));
      return { count: hit.length };
    },
    update: async ({ where, data }) => { apply(db.orders[where.id], data); return { ...db.orders[where.id] }; },
    findMany: async () => []
  },
  orderStatusHistory: { create: async ({ data }) => { db.history.push(data); return data; } },
  installment: { findMany: async () => [] }, // heldAmount (vendas retidas do próprio utilizador): nenhuma
  orderItem: { findMany: async () => [{ productId: 'p1', name: 'Camisola', qty: 1 }] },
  bazar: { update: async ({ data }) => { db.bazarSales += data.totalSales.increment; return {}; } },
  transaction: { create: async ({ data }) => data },
  product: { update: async () => { db.productSales++; return {}; }, updateMany: async () => ({ count: 1 }) },
  wallet: {
    findUnique: async ({ where }) => (where.userId ? { ...walletOf(where.userId) } : Object.values(db.wallets).find((w) => w.id === where.id)),
    create: async ({ data }) => walletOf(data.userId),
    update: async ({ where, data }) => { const w = Object.values(db.wallets).find((x) => x.id === where.id); apply(w, data); return { ...w }; },
    updateMany: async ({ where, data }) => {
      const w = Object.values(db.wallets).find((x) => x.id === where.id);
      if (!w || w.balance < where.balance.gte) return { count: 0 };
      apply(w, data); return { count: 1 };
    }
  },
  walletTransaction: { create: async ({ data }) => { db.walletTx.push(data); return data; } },
  orderDispute: { create: async ({ data }) => { const d = { id: 'd1', status: 'OPEN', ...data }; db.disputes.push(d); return d; }, updateMany: async () => ({ count: 1 }) }
};
const prisma = {
  ...tx,
  $transaction: async (fn) => {
    // Transacção a sério: se falhar, repõe o estado (como o Postgres faria).
    const snap = JSON.stringify({ o: db.orders, w: db.wallets, t: db.walletTx });
    const lenH = db.history.length;
    try { return await fn(tx); } catch (e) {
      const s = JSON.parse(snap); db.orders = s.o; db.wallets = s.w; db.walletTx = s.t; db.history.length = lenH;
      for (const o of Object.values(db.orders)) for (const k of ['payDeadline', 'deliveryDeadline', 'paidAt', 'acceptedAt', 'codeLockedUntil']) if (o[k]) o[k] = new Date(o[k]);
      throw e;
    }
  },
  user: { findMany: async () => [] }
};

const stubs = {
  '../config/database': prisma,
  './notificationService': { push: (id, n) => db.pushed.push({ id, ...n }) },
  '../services/notificationService': { push: (id, n) => db.pushed.push({ id, ...n }) },
  './walletFlowService': { verifyPin: async () => { if (!db.pinOk) { const e = new Error('PIN incorrecto.'); e.name = 'WalletFlowError'; e.status = 400; e.code = 'PIN_INVALID'; throw e; } return true; } },
  './couponService': { revertForOrderTx: async () => {} },
  './eventBus': { EVENTS: { ORDER_STATUS_CHANGED: 'X' }, emit: (e, p) => db.events.push(p) },
  './featureFlags': { isEnabled: async () => true },
  '../utils/logger': { info() {}, warn() {}, error() {} }
};
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (stubs[req] && parent && /(escrowService|walletService)\.js$/.test(parent.filename)) return stubs[req];
  return orig.call(this, req, parent, ...r);
};
const escrow = require(path.join(root, 'src/services/escrowService.js'));
const wallet = (u) => walletOf(u).balance;
const payload = (e) => e && (e.status || e.name);

beforeEach(reset);
reset();

const acceptAndPay = async () => {
  await escrow.accept('seller', 'o1');
  return escrow.pay('buyer', 'o1', { pin: '4821' });
};

test('código: determinístico, 6 dígitos, diferente por encomenda/nonce, e o formato é normalizado', () => {
  const a = escrow.deriveCode('o1', 'n1');
  assert.match(a, /^\d{6}$/);
  assert.strictEqual(a, escrow.deriveCode('o1', 'n1'));
  assert.notStrictEqual(a, escrow.deriveCode('o1', 'n2'));
  assert.notStrictEqual(a, escrow.deriveCode('o2', 'n1'));
  assert.strictEqual(escrow.normalizeCode('123 456'), '123456');
  assert.strictEqual(escrow.normalizeCode('12345'), null);
  assert.strictEqual(escrow.normalizeCode('12345a'), null);
});

test('publicOrder nunca expõe o nonce do código nem a chave de idempotência', () => {
  const o = escrow.publicOrder({ ...mkOrder(), codeNonce: 'segredo', payIdempotencyKey: 'k', codeAttempts: 2, escrowState: 'RETIDO', escrowAmount: 200 });
  assert.ok(!('codeNonce' in o) && !('payIdempotencyKey' in o) && !('codeAttempts' in o));
  assert.strictEqual(o.escrow.state, 'RETIDO');
});

test('aceitar: só o vendedor, só PENDENTE; repetir é idempotente; define prazo de pagamento', async () => {
  await assert.rejects(() => escrow.accept('buyer', 'o1'), (e) => payload(e) === 404);
  const r = await escrow.accept('seller', 'o1');
  assert.strictEqual(r.order.status, 'ACEITE');
  assert.ok(db.orders.o1.payDeadline > new Date());
  assert.ok(db.pushed.some((n) => n.id === 'buyer' && /aceite/i.test(n.title)));
  const again = await escrow.accept('seller', 'o1');
  assert.strictEqual(again.already, true);
});

test('pagar antes de o vendedor aceitar é recusado', async () => {
  await assert.rejects(() => escrow.pay('buyer', 'o1', { pin: '4821' }), (e) => e.code === 'ORDER_NOT_ACCEPTED');
  assert.strictEqual(wallet('buyer'), 500);
});

test('pagar: debita o comprador, retém, NÃO paga o vendedor, devolve o código', async () => {
  const r = await acceptAndPay();
  assert.match(r.deliveryCode, /^\d{6}$/);
  assert.strictEqual(wallet('buyer'), 300);
  assert.strictEqual(wallet('seller'), 0); // vendedor ainda não recebeu
  assert.strictEqual(db.orders.o1.escrowState, 'RETIDO');
  assert.strictEqual(db.orders.o1.escrowAmount, 200);
  assert.strictEqual(db.walletTx.length, 1);
  assert.strictEqual(db.walletTx[0].type, 'PAGAMENTO_COMPRA');
  assert.ok(!('codeNonce' in r.order));
});

test('pagar duas vezes (duplo toque): cobra UMA vez e devolve o mesmo código', async () => {
  const [a, b] = await Promise.all([escrow.accept('seller', 'o1').then(() => escrow.pay('buyer', 'o1', { pin: '4821', idempotencyKey: 'k1' })), Promise.resolve()]);
  const c = await escrow.pay('buyer', 'o1', { pin: '4821', idempotencyKey: 'k1' });
  assert.strictEqual(wallet('buyer'), 300);
  assert.strictEqual(db.walletTx.length, 1);
  assert.strictEqual(c.already, true);
  assert.strictEqual(c.deliveryCode, a.deliveryCode);
});

test('pagar com saldo insuficiente: nada é retido e o estado volta atrás (transacção)', async () => {
  db.wallets.buyer.balance = 50;
  await escrow.accept('seller', 'o1');
  await assert.rejects(() => escrow.pay('buyer', 'o1', { pin: '4821' }), (e) => e.code === 'INSUFFICIENT_FUNDS');
  assert.strictEqual(db.orders.o1.escrowState, null);
  assert.strictEqual(wallet('buyer'), 50);
});

test('pagar com PIN errado: nada acontece', async () => {
  await escrow.accept('seller', 'o1');
  db.pinOk = false;
  await assert.rejects(() => escrow.pay('buyer', 'o1', { pin: '0000' }), (e) => e.code === 'PIN_INVALID');
  assert.strictEqual(db.orders.o1.escrowState, null);
  assert.strictEqual(wallet('buyer'), 500);
});

test('pagar depois do prazo: recusado', async () => {
  await escrow.accept('seller', 'o1');
  db.orders.o1.payDeadline = new Date(Date.now() - 1000);
  await assert.rejects(() => escrow.pay('buyer', 'o1', { pin: '4821' }), (e) => e.code === 'PAY_WINDOW_EXPIRED');
});

test('código de entrega: só o comprador o vê; antes de pagar não existe', async () => {
  await escrow.accept('seller', 'o1');
  await assert.rejects(() => escrow.getDeliveryCode('buyer', 'o1'), (e) => e.code === 'ORDER_NOT_PAID');
  const { deliveryCode } = await escrow.pay('buyer', 'o1', { pin: '4821' });
  const seen = await escrow.getDeliveryCode('buyer', 'o1');
  assert.strictEqual(seen.code, deliveryCode);
  await assert.rejects(() => escrow.getDeliveryCode('seller', 'o1'), (e) => payload(e) === 404); // nunca ao vendedor
  await assert.rejects(() => escrow.getDeliveryCode('intruso', 'o1'), (e) => payload(e) === 404);
});

test('libertar com o código certo: vendedor recebe, encomenda ENTREGUE, dinheiro conservado', async () => {
  const { deliveryCode } = await acceptAndPay();
  const r = await escrow.release('seller', 'o1', deliveryCode.slice(0, 3) + ' ' + deliveryCode.slice(3));
  assert.strictEqual(r.order.status, 'ENTREGUE');
  assert.strictEqual(db.orders.o1.escrowState, 'LIBERTADO');
  assert.strictEqual(wallet('seller'), 200);
  assert.strictEqual(wallet('buyer'), 300);
  assert.strictEqual(wallet('seller') + wallet('buyer'), 500); // nada se perdeu nem se criou
  assert.strictEqual(db.bazarSales, 200);
  assert.ok(db.walletTx.some((t) => t.type === 'RECEBIMENTO_VENDA' && t.amount === 200));
});

test('libertar duas vezes: paga UMA vez (idempotente)', async () => {
  const { deliveryCode } = await acceptAndPay();
  await escrow.release('seller', 'o1', deliveryCode);
  const again = await escrow.release('seller', 'o1', deliveryCode);
  assert.strictEqual(again.already, true);
  assert.strictEqual(wallet('seller'), 200);
});

test('só o vendedor da encomenda liberta; o comprador não pode libertar o próprio dinheiro', async () => {
  const { deliveryCode } = await acceptAndPay();
  await assert.rejects(() => escrow.release('buyer', 'o1', deliveryCode), (e) => payload(e) === 404);
  assert.strictEqual(wallet('seller'), 0);
});

test('código errado: conta tentativas; ao chegar ao máximo bloqueia e avisa o comprador', async () => {
  const { deliveryCode } = await acceptAndPay();
  const wrong = deliveryCode === '000000' ? '111111' : '000000';
  await assert.rejects(() => escrow.release('seller', 'o1', wrong), (e) => e.code === 'CODE_INVALID' && e.extra.attemptsLeft === 2);
  await assert.rejects(() => escrow.release('seller', 'o1', wrong), (e) => e.code === 'CODE_INVALID' && e.extra.attemptsLeft === 1);
  await assert.rejects(() => escrow.release('seller', 'o1', wrong), (e) => e.code === 'CODE_LOCKED');
  assert.ok(db.orders.o1.codeLockedUntil > new Date());
  assert.ok(db.pushed.some((n) => n.id === 'buyer' && /errados/i.test(n.title)));
  // Bloqueado: nem o código CERTO passa até o bloqueio acabar.
  await assert.rejects(() => escrow.release('seller', 'o1', deliveryCode), (e) => e.code === 'CODE_LOCKED');
  assert.strictEqual(wallet('seller'), 0);
  // Passado o bloqueio, o código certo funciona.
  db.orders.o1.codeLockedUntil = new Date(Date.now() - 1000);
  const ok = await escrow.release('seller', 'o1', deliveryCode);
  assert.strictEqual(ok.order.status, 'ENTREGUE');
});

test('tentativas em paralelo não passam do máximo (reserva atómica)', async () => {
  const { deliveryCode } = await acceptAndPay();
  const wrong = deliveryCode === '000000' ? '111111' : '000000';
  const res = await Promise.allSettled(Array.from({ length: 10 }, () => escrow.release('seller', 'o1', wrong)));
  const counted = res.filter((r) => r.status === 'rejected' && ['CODE_INVALID', 'CODE_LOCKED'].includes(r.reason.code));
  assert.strictEqual(counted.length, 10, JSON.stringify(res.map((r) => r.status === 'rejected' ? r.reason.code || r.reason.message : 'ok')));
  assert.ok(db.orders.o1.codeAttempts <= 3);
});

test('código com formato inválido não gasta tentativas', async () => {
  await acceptAndPay();
  await assert.rejects(() => escrow.release('seller', 'o1', '12ab'), (e) => e.code === 'CODE_FORMAT');
  assert.strictEqual(db.orders.o1.codeAttempts, 0);
});

test('depois do prazo de entrega já não se liberta (o dinheiro volta ao comprador)', async () => {
  const { deliveryCode } = await acceptAndPay();
  db.orders.o1.deliveryDeadline = new Date(Date.now() - 1000);
  await assert.rejects(() => escrow.release('seller', 'o1', deliveryCode), (e) => e.code === 'DELIVERY_WINDOW_EXPIRED');
});

test('reembolso (cancelar/expirar): o dinheiro retido volta ao comprador, tudo na mesma transacção', async () => {
  await acceptAndPay();
  const order = { ...db.orders.o1 };
  await prisma.$transaction(async (t) => { await escrow.refundTx(t, order, { note: 'teste' }); });
  assert.strictEqual(wallet('buyer'), 500);
  assert.strictEqual(wallet('seller'), 0);
  assert.ok(db.walletTx.some((t) => t.type === 'REEMBOLSO_COMPRA' && t.amount === 200));
});

test('disputa: congela o dinheiro; depois disso o código já não liberta e não se pode cancelar', async () => {
  const { deliveryCode } = await acceptAndPay();
  const d = await escrow.openDispute('buyer', { ...db.orders.o1 }, { reason: 'NOT_AS_DESCRIBED', description: 'O produto não é o que estava no anúncio.' });
  assert.strictEqual(d.openedById, 'buyer');
  assert.strictEqual(db.orders.o1.escrowState, 'CONGELADO');
  await assert.rejects(() => escrow.release('seller', 'o1', deliveryCode), (e) => e.code === 'ORDER_IN_DISPUTE');
  assert.throws(() => escrow.guardLegacyTransition(db.orders.o1, 'CANCELADA'), (e) => e.code === 'ORDER_IN_DISPUTE');
  // o comprador continua a poder ver o código; o vendedor continua sem poder
  assert.strictEqual((await escrow.getDeliveryCode('buyer', 'o1')).code, deliveryCode);
});

test('o vendedor também pode abrir disputa; um terceiro não', async () => {
  await acceptAndPay();
  await assert.rejects(() => escrow.openDispute('intruso', { ...db.orders.o1 }, { reason: 'OTHER', description: 'Não tenho nada a ver com isto.' }), (e) => payload(e) === 404);
  const d = await escrow.openDispute('seller', { ...db.orders.o1 }, { reason: 'OTHER', description: 'O comprador não aparece ao encontro.' });
  assert.strictEqual(d.openedById, 'seller');
});

test('guardas do PATCH /status: na compra segura não se marca entregue/preparação à mão', () => {
  const o = { ...mkOrder(), status: 'ACEITE', escrowState: 'RETIDO' };
  for (const to of ['ENTREGUE', 'EM_ENTREGA', 'EM_PREPARACAO', 'ACEITE']) assert.throws(() => escrow.guardLegacyTransition(o, to), (e) => e.status === 400, to);
  assert.doesNotThrow(() => escrow.guardLegacyTransition(o, 'CANCELADA'));
  assert.doesNotThrow(() => escrow.guardLegacyTransition({ ...o, paymentMode: 'ENTREGA' }, 'ENTREGUE')); // encomendas antigas não mudam
});
