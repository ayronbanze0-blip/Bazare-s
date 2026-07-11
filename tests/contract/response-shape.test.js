'use strict';

/**
 * TESTES DE CONTRATO — response-shape
 * ============================================================
 * Objectivo directo: nunca mais permitir o bug dos "Favoritos" — o
 * backend devolvia `{ data: { favorites: [...] } }`, o favorites.html
 * lia `res?.data?.products`, e a página ficava sempre vazia sem
 * nenhum erro visível em lado nenhum. Nem o backend nem o frontend
 * "rebentavam" — só ficavam silenciosamente incompatíveis.
 *
 * Estes testes chamam os controllers directamente (sem servidor HTTP,
 * sem base de dados real — o Prisma é mockado) e verificam que a
 * chave `data` da resposta contém exactamente as chaves listadas em
 * `api-contract.json`, que é a fonte única de verdade do que o
 * frontend efectivamente lê (`res?.data?.X`).
 *
 * Correr: npm test
 * Ao mudar uma chave de resposta: actualizar primeiro o
 * api-contract.json (e o frontend), só depois o controller — assim o
 * teste força a decisão consciente em vez de deixar passar por acaso.
 */

const contract = require('./api-contract.json');

// ─── Mock do Prisma ────────────────────────────────────────────────
// Cada teste define o que os métodos usados devem devolver; os
// restantes ficam como jest.fn() genéricos para não rebentar chamadas
// que o controller faça e o teste não precise de verificar.
function makePrismaMock(overrides = {}) {
  const base = {
    product: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    favorite: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), count: jest.fn() },
    bazar: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    cartItem: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
    order: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    notification: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    walletTransaction: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    wallet: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(base))
  };
  return { ...base, ...overrides };
}

// Fake req/res no estilo Express — só o suficiente para os controllers.
function makeReqRes({ user = { id: 'u1', role: 'BUYER' }, params = {}, query = {}, body = {} } = {}) {
  const req = { user, params, query, body };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  return { req, res };
}

// Verifica que res.payload.data tem exactamente as chaves esperadas
// pelo contrato (nem a mais, nem a menos — um novo campo silencioso
// também merece ser uma decisão consciente, não um acidente).
function expectContractKeys(res, contractKey) {
  const expected = contract[contractKey]?.dataKeys;
  if (!expected) throw new Error(`Contrato não definido para "${contractKey}" em api-contract.json`);
  expect(res.payload).toBeTruthy();
  expect(res.payload.success).toBe(true);
  const actualKeys = Object.keys(res.payload.data || {}).sort();
  expect(actualKeys).toEqual([...expected].sort());
}

describe('Contrato de resposta — Produtos', () => {
  test('GET /products devolve {products, meta}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]), count: jest.fn().mockResolvedValue(1) },
      favorite: { findMany: jest.fn().mockResolvedValue([]) }
    }));
    const ctrl = require('../../src/controllers/productController');
    const { req, res } = makeReqRes();
    await ctrl.list(req, res);
    expectContractKeys(res, 'GET /products');
  });

  test('GET /products/featured devolve {products}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) },
      favorite: { findMany: jest.fn().mockResolvedValue([]) }
    }));
    const ctrl = require('../../src/controllers/productController');
    const { req, res } = makeReqRes();
    await ctrl.featured(req, res);
    expectContractKeys(res, 'GET /products/featured');
  });

  test('GET /products/:id/related devolve {products}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      product: {
        findUnique: jest.fn().mockResolvedValue({ category: 'Sapatilhas', bazarId: 'b1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'p2' }])
      },
      favorite: { findMany: jest.fn().mockResolvedValue([]) }
    }));
    const ctrl = require('../../src/controllers/productController');
    const { req, res } = makeReqRes({ params: { id: 'p1' } });
    await ctrl.related(req, res);
    expectContractKeys(res, 'GET /products/:id/related');
  });

  // Este é literalmente o bug que motivou este ficheiro: myFavorites
  // tinha de devolver "products", não "favorites".
  test('GET /products/favorites devolve {products} — regressão do bug dos Favoritos', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      favorite: { findMany: jest.fn().mockResolvedValue([{ product: { id: 'p1', name: 'AF1' } }]) }
    }));
    const ctrl = require('../../src/controllers/productController');
    const { req, res } = makeReqRes();
    await ctrl.myFavorites(req, res);
    expectContractKeys(res, 'GET /products/favorites');
    expect(res.payload.data.products[0].id).toBe('p1');
  });

  test('GET /products/:id devolve {product}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      product: {
        findFirst: jest.fn().mockResolvedValue({ id: 'p1', name: 'AF1' }),
        update: jest.fn().mockResolvedValue({})
      },
      favorite: { findUnique: jest.fn().mockResolvedValue(null) }
    }));
    const ctrl = require('../../src/controllers/productController');
    const { req, res } = makeReqRes({ params: { id: 'p1' } });
    await ctrl.getOne(req, res);
    expectContractKeys(res, 'GET /products/:id');
  });
});

describe('Contrato de resposta — Bazares', () => {
  test('GET /bazars/:idOrSlug devolve {bazar}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock({
      bazar: { findFirst: jest.fn().mockResolvedValue({ id: 'b1', products: [{ id: 'p1' }] }) },
      favorite: { findMany: jest.fn().mockResolvedValue([]) }
    }));
    const ctrl = require('../../src/controllers/bazarController');
    const { req, res } = makeReqRes({ params: { idOrSlug: 'loja-do-joao' } });
    await ctrl.getOne(req, res);
    expectContractKeys(res, 'GET /bazars/:idOrSlug');
  });
});

describe('Contrato de resposta — Encomendas, Wallet, Notificações', () => {
  test('GET /orders/mine devolve {orders, meta}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock());
    const ctrl = require('../../src/controllers/orderController');
    const { req, res } = makeReqRes();
    await ctrl.myOrders(req, res);
    expectContractKeys(res, 'GET /orders/mine');
  });

  test('GET /notifications devolve {notifications, unreadCount, meta}', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/database', () => makePrismaMock());
    const ctrl = require('../../src/controllers/notificationController');
    const { req, res } = makeReqRes();
    await ctrl.list(req, res);
    expectContractKeys(res, 'GET /notifications');
  });
});

