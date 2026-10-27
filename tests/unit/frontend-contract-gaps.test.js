// Lacunas de contacto frontend↔backend corrigidas:
//  1) GET /friends/mutual/:userId (o frontend chamava e dava 404)
//  2) GET /wallet/summary → withdrawalsToday (Mente.risco.levantamento)
//  3) GET /products/:id → bazar.seller com nota/avaliações/votos/antiguidade/vendas (selo de confiança)
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── 1) amigos em comum: comportamento real do controlador, BD simulada ──────────
const amizades = []; // { requesterId, addresseeId, status }
const users = {};     // id -> { id, name, active }
let bloqueios = [];   // [a, b] pares bloqueados
const prisma = {
  friendship: {
    findMany: async ({ where }) => {
      const uid = where.OR[0].requesterId;
      return amizades.filter((f) => f.status === 'ACCEPTED' && (f.requesterId === uid || f.addresseeId === uid));
    }
  },
  user: {
    findMany: async ({ where, take, skip }) => where.id.in.map((id) => users[id]).filter((u) => u && u.active === where.active)
      .sort((a, b) => a.name.localeCompare(b.name)).slice(skip, skip + take),
    count: async ({ where }) => where.id.in.map((id) => users[id]).filter((u) => u && u.active === where.active).length
  }
};
const stubs = {
  '../config/database': prisma,
  '../utils/logger': { error() {}, warn() {}, info() {} },
  '../services/blockService': {
    isBlockedEither: async (a, b) => bloqueios.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    getHiddenUserIds: async (me) => new Set(bloqueios.filter(([x, y]) => x === me || y === me).map(([x, y]) => (x === me ? y : x)))
  },
  '../services/notificationService': {}, '../services/friendService': {}
};
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (stubs[req] && parent && /friendController\.js$/.test(parent.filename)) return stubs[req];
  return orig.call(this, req, parent, ...r);
};
const friendCtrl = require(path.join(root, 'src/controllers/friendController.js'));
Module._load = orig;

function pessoa(id, name, active = true) { users[id] = { id, name, username: id, avatarUrl: null, isPremium: false, verifiedSeller: false, active, bazar: null }; }
function amigos(a, b) { amizades.push({ requesterId: a, addresseeId: b, status: 'ACCEPTED' }); }
async function chamar(me, other, query = {}) {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  await friendCtrl.mutual({ user: { id: me }, params: { userId: other }, query }, res);
  return out.body.data || out.body;
}

test('mutual: devolve só os amigos que as duas pessoas têm em comum, ordenados por nome', async () => {
  amizades.length = 0; bloqueios = [];
  ['me', 'ana', 'beto', 'carla', 'dino', 'eva'].forEach((id) => pessoa(id, id === 'me' ? 'Eu' : id[0].toUpperCase() + id.slice(1)));
  amigos('me', 'ana'); amigos('beto', 'me'); amigos('me', 'carla');          // meus amigos: ana, beto, carla
  amigos('ana', 'eva'); amigos('dino', 'ana'); amigos('beto', 'eva'); // eva: ana, beto (carla não)
  const r = await chamar('me', 'eva');
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.items.map((i) => i.name), ['Ana', 'Beto']);
  assert.ok(r.items.every((i) => i.id && 'avatarUrl' in i));   // formato `person()` igual a /friends
  assert.strictEqual(r.meta.total, 2);
});

test('mutual: sem ninguém em comum, a própria pessoa, ou id vazio → lista vazia (nunca erro)', async () => {
  pessoa('fred', 'Fred');                                          // não tem amigos
  assert.strictEqual((await chamar('me', 'fred')).count, 0);
  assert.strictEqual((await chamar('me', 'dino')).count, 1);       // dino só é amigo da ana — que também é minha amiga
  assert.strictEqual((await chamar('me', 'me')).count, 0);
  assert.strictEqual((await chamar('me', '')).count, 0);
  assert.deepStrictEqual((await chamar('me', 'xpto')).items, []);
});

test('mutual: bloqueio entre nós ou com o amigo comum não revela nada', async () => {
  bloqueios = [['me', 'eva']];                                    // bloqueio comigo ↔ eva: vazio, sem revelar
  assert.strictEqual((await chamar('me', 'eva')).count, 0);
  bloqueios = [['beto', 'me']];                                   // beto bloqueou-me: não aparece nos comuns
  const r = await chamar('me', 'eva');
  assert.deepStrictEqual(r.items.map((i) => i.name), ['Ana']);
  bloqueios = [];
});

test('mutual: ignora contas desactivadas e pagina', async () => {
  users.beto.active = false;
  assert.deepStrictEqual((await chamar('me', 'eva')).items.map((i) => i.name), ['Ana']);
  users.beto.active = true;
  const p2 = await chamar('me', 'eva', { limit: 1, page: 2 });
  assert.deepStrictEqual(p2.items.map((i) => i.name), ['Beto']);
  assert.strictEqual(p2.meta.pages, 2);
});

test('rota GET /friends/mutual/:userId está registada e exige login', () => {
  const r = read('src/routes/friendRoutes.js');
  assert.match(r, /router\.get\('\/mutual\/:userId', authenticate, ctrl\.mutual\)/);
});

// ── 2) carteira ────────────────────────────────────────────────
test('wallet/summary devolve withdrawalsToday (nº, não valor) no topo, onde o ecrã o lê', () => {
  const s = read('src/services/walletFlowService.js');
  assert.match(s, /const countToday = async/);
  assert.match(s, /countToday\(prisma, wallet\.id, 'DEBITO_LEVANTAMENTO', now\)/);
  assert.match(s, /pinLockedMinutes: lockedMin,\s*\n\s*withdrawalsToday,/);
});

// ── 3) produto: dados de confiança do vendedor ─────────────────
test('GET /products/:id inclui os campos do selo de confiança e as vendas reais (não Bazar.totalSales)', () => {
  const s = read('src/controllers/productController.js');
  assert.match(s, /seller: \{ select: \{ verifiedSeller: true, isPremium: true, rating: true, ratingCount: true, thumbsUp: true, thumbsDown: true, createdAt: true \} \}/);
  assert.match(s, /seller\.sales = await stage\('vendas-vendedor'/);
  assert.match(s, /status: 'ENTREGUE'/);
  assert.ok(!/seller\.sales = [^;]*totalSales/.test(s), 'totalSales é dinheiro (MT), não nº de vendas');
});
