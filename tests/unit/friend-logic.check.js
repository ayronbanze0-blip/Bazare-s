// Verificação de lógica das amizades com uma BD simulada (sem Prisma/Postgres). Correr: node tests/friend-logic.check.js
const Module = require('module');
const path = require('path');
const root = process.cwd();
// ── base de dados simulada em memória ──
const db = { friendship: [], user: [
  { id:'A', name:'Ana', active:true, username:'ana', avatarUrl:null, isPremium:false, verifiedSeller:false, bazar:null },
  { id:'B', name:'Beto', active:true, username:'beto', avatarUrl:null, isPremium:false, verifiedSeller:false, bazar:{id:'bz1',name:'Loja B',slug:'loja-b'} },
  { id:'C', name:'Carla', active:true, username:'carla', avatarUrl:null, isPremium:false, verifiedSeller:false, bazar:null },
  { id:'X', name:'Inativo', active:false, username:'x', avatarUrl:null, bazar:null } ] };
let seq = 0;
const match = (r, w) => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return v.some((c) => match(r, c));
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
  return r[k] === v;
});
const prisma = {
  friendship: {
    findMany: async ({ where, take, include }) => db.friendship.filter((r) => match(r, where || {})).slice(0, take || 999).map((r) => include ? { ...r, requester: db.user.find((u) => u.id === r.requesterId), addressee: db.user.find((u) => u.id === r.addresseeId) } : r),
    findFirst: async ({ where }) => db.friendship.find((r) => match(r, where)) || null,
    count: async ({ where }) => db.friendship.filter((r) => match(r, where)).length,
    create: async ({ data }) => { if (db.friendship.some((r) => r.requesterId === data.requesterId && r.addresseeId === data.addresseeId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } const r = { id: 'f' + (++seq), status: 'PENDING', createdAt: new Date(), respondedAt: null, ...data }; db.friendship.push(r); return r; },
    updateMany: async ({ where, data }) => { const rows = db.friendship.filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
    deleteMany: async ({ where }) => { const rows = db.friendship.filter((r) => match(r, where)); db.friendship = db.friendship.filter((r) => !rows.includes(r)); return { count: rows.length }; }
  },
  user: { findUnique: async ({ where }) => db.user.find((u) => u.id === where.id) || null,
          findMany: async ({ where }) => db.user.filter((u) => u.active && (!where.id || !where.id.in || where.id.in.includes(u.id)) && (!where.OR || where.OR.some((c) => (c.name && u.name.toLowerCase().includes(c.name.contains.toLowerCase())) || (c.username && (u.username||'').includes(c.username.contains.toLowerCase())))) && (!where.id || !where.id.not || u.id !== where.id.not) && (!where.id || !where.id.notIn || !where.id.notIn.includes(u.id)) && (!where.bazar || !where.bazar.isNot === false || u.bazar)) }
};
const notified = [];
const stubs = {
  '../config/database': prisma,
  '../services/blockService': { getHiddenUserIds: async () => new Set(), isBlockedEither: async () => false },
  '../services/notificationService': { friendRequest: async (...a) => notified.push(['req', ...a]), friendAccepted: async (...a) => notified.push(['acc', ...a]) },
  '../utils/logger': { error: (m) => console.log('LOGGER.ERROR', m), warn() {}, info() {} }
};
const orig = Module._load;
Module._load = function (req, parent, ...r) { if (stubs[req] && parent && /friend(Controller|Service)/.test(parent.filename)) return stubs[req]; return orig.call(this, req, parent, ...r); };
const ctrl = require(path.join(root, 'src/controllers/friendController.js'));
const call = async (fn, user, { params = {}, query = {} } = {}) => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } }; await fn({ user, params, query }, res); return out; };
const A = { id: 'A', name: 'Ana' }, B = { id: 'B', name: 'Beto' }, C = { id: 'C', name: 'Carla' };
const eq = (l, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(ok ? 'OK  ' : 'FALHA', l, ok ? '' : `\n   obtido=${JSON.stringify(a)} esperado=${JSON.stringify(b)}`); if (!ok) process.exitCode = 1; };
(async () => {
  let r = await call(ctrl.request, A, { params: { userId: 'A' } }); eq('pedir a si próprio → 400', r.code, 400);
  r = await call(ctrl.request, A, { params: { userId: 'X' } }); eq('pedir a conta inactiva → 404', r.code, 404);
  r = await call(ctrl.request, A, { params: { userId: 'B' } }); eq('A pede a B', r.body.data.status, 'REQUEST_SENT');
  r = await call(ctrl.request, A, { params: { userId: 'B' } }); eq('pedido repetido é idempotente', r.body.data.status, 'REQUEST_SENT');
  eq('só 1 linha criada', db.friendship.length, 1);
  eq('B notificado só uma vez (pedido repetido não volta a notificar)', notified.filter((n) => n[0] === 'req').length, 1);
  r = await call(ctrl.summary, B); eq('B vê 1 pedido recebido', r.body.data, { friends: 0, received: 1, sent: 0 });
  r = await call(ctrl.requests, B, { query: { box: 'received' } }); eq('lista de recebidos mostra a Ana', r.body.data.items.map((i) => i.name), ['Ana']);
  const fid = db.friendship[0].id;
  r = await call(ctrl.accept, A, { params: { id: fid } }); eq('A não pode aceitar o próprio pedido → 404', r.code, 404);
  r = await call(ctrl.accept, B, { params: { id: fid } }); eq('B aceita', r.body.data.status, 'FRIENDS');
  eq('A notificada da aceitação', notified.some((n) => n[0] === 'acc' && n[1] === 'A'), true);
  r = await call(ctrl.list, A); eq('A vê o Beto nos amigos', r.body.data.items.map((i) => i.name), ['Beto']);
  r = await call(ctrl.list, B); eq('B vê a Ana nos amigos', r.body.data.items.map((i) => i.name), ['Ana']);
  r = await call(ctrl.status, A, { params: { userId: 'B' } }); eq('estado A→B', r.body.data.status, 'FRIENDS');
  // pedidos cruzados: C pede a A; A pede a C → aceita em vez de duplicar
  await call(ctrl.request, C, { params: { userId: 'A' } });
  r = await call(ctrl.request, A, { params: { userId: 'C' } }); eq('pedir de volta = aceitar', r.body.data.status, 'FRIENDS');
  eq('continua 2 linhas (sem duplicados)', db.friendship.length, 2);
  r = await call(ctrl.suggestions, B); eq('sugestões de B: Carla (amiga em comum: Ana), sem B, sem Ana, sem duplicados', r.body.data.items.map((i) => [i.name, i.mutual]), [['Carla', 1]]);
  r = await call(ctrl.search, A, { query: { q: 'be' } }); eq('pesquisa "be" mostra Beto como amigo', r.body.data.items.map((i) => [i.name, i.relation.status]), [['Beto', 'FRIENDS']]);
  r = await call(ctrl.search, A, { query: { q: 'b' } }); eq('pesquisa curta devolve vazio', r.body.data.items, []);
  r = await call(ctrl.removeWith, B, { params: { userId: 'A' } }); eq('B desfaz a amizade com A', r.body.data.status, 'NONE');
  r = await call(ctrl.status, A, { params: { userId: 'B' } }); eq('estado A→B depois de remover', r.body.data.status, 'NONE');
  r = await call(ctrl.request, B, { params: { userId: 'C' } }); await call(ctrl.decline, C, { params: { id: db.friendship.find((f) => f.requesterId === 'B').id } });
  r = await call(ctrl.status, B, { params: { userId: 'C' } }); eq('recusar apaga o pedido', r.body.data.status, 'NONE');
})();
