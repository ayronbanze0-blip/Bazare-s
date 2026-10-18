// Lógica de comunidades com aprovação de entrada, com BD simulada (sem Prisma/Postgres).
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');
const root = process.cwd();

const db = { community: [], member: [], req: [], notified: [] };
let seq = 0;
const prisma = {
  community: {
    findFirst: async () => db.community[0] || null,
    create: async ({ data }) => { const { members, ...c } = data; const row = { id: 'c' + (++seq), createdAt: new Date(), ...c }; db.community.push(row); (members?.create ? [members.create] : []).forEach((m) => db.member.push({ id: 'm' + (++seq), communityId: row.id, ...m })); return row; },
    update: async ({ data }) => Object.assign(db.community[0], data)
  },
  communityMember: {
    findUnique: async ({ where }) => db.member.find((m) => m.communityId === where.communityId_userId.communityId && m.userId === where.communityId_userId.userId) || null,
    findMany: async ({ where }) => db.member.filter((m) => m.userId === where.userId),
    create: async ({ data }) => { const r = { id: 'm' + (++seq), ...data }; db.member.push(r); return r; },
    upsert: async ({ where, create }) => { const k = where.communityId_userId; return db.member.find((m) => m.communityId === k.communityId && m.userId === k.userId) || (db.member.push({ id: 'm' + (++seq), ...create }), create); },
    delete: async ({ where }) => { db.member = db.member.filter((m) => m.id !== where.id); },
    groupBy: async () => [{ communityId: db.community[0]?.id, _count: db.member.length }]
  },
  communityPost: { groupBy: async () => [] },
  communityJoinRequest: {
    upsert: async ({ where, create, update }) => { const k = where.communityId_userId; let r = db.req.find((x) => x.communityId === k.communityId && x.userId === k.userId); if (r) Object.assign(r, update); else { r = { id: 'r' + (++seq), createdAt: new Date(), ...create }; db.req.push(r); } return r; },
    findUnique: async ({ where }) => { const k = where.communityId_userId; return db.req.find((x) => x.communityId === k.communityId && x.userId === k.userId) || null; },
    findMany: async ({ where }) => db.req.filter((x) => (!where.userId || x.userId === where.userId) && (!where.status || x.status === where.status)).map((x) => ({ ...x, user: { id: x.userId, name: 'U' + x.userId } })),
    count: async ({ where }) => db.req.filter((x) => x.status === where.status).length,
    update: async ({ where, data }) => Object.assign(db.req.find((x) => x.id === where.id), data),
    deleteMany: async ({ where }) => { const n = db.req.length; db.req = db.req.filter((x) => !(x.communityId === where.communityId && x.userId === where.userId && (!where.status || x.status === where.status))); return { count: n - db.req.length }; },
    groupBy: async () => [{ communityId: db.community[0]?.id, _count: db.req.filter((x) => x.status === 'PENDING').length }]
  },
  $transaction: async (ops) => Promise.all(ops)
};
const stubs = {
  '../config/database': prisma,
  '../utils/helpers': { sanitize: (s) => String(s), paginate: () => ({ take: 30, skip: 0 }), paginateMeta: () => ({}), uniqueSlug: async (_p, n) => String(n).toLowerCase().replace(/\s+/g, '-') },
  '../services/uploadService': {}, '../services/mentionService': {},
  '../services/blockService': { isBlockedEither: async () => false, getHiddenUserIdsSafe: async () => new Set() },
  '../services/feedEngagementService': { attachDirectEngagement: async (x) => x },
  '../services/notificationService': { push: async (uid, n) => { db.notified.push([uid, n.title]); } },
  '../utils/logger': { error: (m) => console.log('LOGGER.ERROR', m), warn() {}, info() {} }
};
const orig = Module._load;
Module._load = function (req, parent, ...r) { if (stubs[req] && parent && /community(Controller|Service)/.test(parent.filename)) return stubs[req]; return orig.call(this, req, parent, ...r); };
const ctrl = require(path.join(root, 'src/controllers/communityController.js'));
const svc = require(path.join(root, 'src/services/communityService.js'));

const call = async (fn, user, { params = { idOrSlug: 'c1' }, body = {}, query = {} } = {}) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  await fn({ user, params, body, query }, res); return out;
};
const OWNER = { id: 'O', name: 'Dona' }, B = { id: 'B', name: 'Beto' }, C = { id: 'C', name: 'Carla' };

test('parseBool aceita texto de multipart', () => {
  assert.strictEqual(svc.parseBool('true'), true);
  assert.strictEqual(svc.parseBool('false'), false);
  assert.strictEqual(svc.parseBool('1'), true);
  assert.strictEqual(svc.parseBool(undefined, true), true);
});

test('fluxo de pedidos de entrada', async () => {
  let r = await call(ctrl.create, OWNER, { body: { name: 'Moda Maputo', rules: 'Sem spam', joinApproval: 'true' } });
  assert.strictEqual(r.code, 201);
  assert.strictEqual(r.body.data.group.joinApproval, true);
  assert.strictEqual(r.body.data.group.rules, 'Sem spam');

  r = await call(ctrl.join, B);
  assert.strictEqual(r.body.data.status, 'PENDING');
  assert.strictEqual(db.member.some((m) => m.userId === 'B'), false, 'não entra sem aprovação');
  assert.ok(db.notified.some((n) => n[0] === 'O'), 'dono notificado');
  await call(ctrl.join, B);
  assert.strictEqual(db.req.length, 1, 'pedido repetido não duplica');

  r = await call(ctrl.getOne, B);
  assert.strictEqual(r.body.data.group.myRequest, 'PENDING');
  assert.strictEqual(r.body.data.group.pendingRequestCount, undefined, 'membro comum não vê a contagem');
  r = await call(ctrl.getOne, OWNER);
  assert.strictEqual(r.body.data.group.myRole, 'ADMIN');
  assert.strictEqual(r.body.data.group.pendingRequestCount, 1);

  r = await call(ctrl.listRequests, C);
  assert.strictEqual(r.code, 403);
  r = await call(ctrl.listRequests, OWNER);
  assert.strictEqual(r.body.data.requests.length, 1);

  r = await call(ctrl.leave, B); // cancelar pedido
  assert.strictEqual(db.req.length, 0);

  await call(ctrl.join, B);
  r = await call(ctrl.declineRequest, OWNER, { params: { idOrSlug: 'c1', userId: 'B' } });
  assert.strictEqual(r.body.data.status, 'DECLINED');
  assert.strictEqual(db.member.some((m) => m.userId === 'B'), false);
  await call(ctrl.join, B); // reabre
  assert.strictEqual(db.req[0].status, 'PENDING');

  r = await call(ctrl.approveRequest, C, { params: { idOrSlug: 'c1', userId: 'B' } });
  assert.strictEqual(r.code, 403, 'só moderação aprova');
  r = await call(ctrl.approveRequest, OWNER, { params: { idOrSlug: 'c1', userId: 'B' } });
  assert.strictEqual(r.body.data.status, 'APPROVED');
  assert.strictEqual(db.member.find((m) => m.userId === 'B').role, 'MEMBER');
  r = await call(ctrl.approveRequest, OWNER, { params: { idOrSlug: 'c1', userId: 'B' } });
  assert.strictEqual(r.code, 404, 'já respondido');
});

test('comunidade sem aprovação: entrada imediata', async () => {
  await call(ctrl.update, OWNER, { body: { joinApproval: 'false' } });
  const r = await call(ctrl.join, C);
  assert.strictEqual(r.body.data.status, 'JOINED');
  assert.ok(db.member.some((m) => m.userId === 'C'));
});
