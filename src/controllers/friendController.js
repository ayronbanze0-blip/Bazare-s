'use strict';

// ─────────────────────────────────────────────────────────────────
// AMIGOS — amizade mútua estilo Facebook (pedido → aceitar).
// Seguir lojas (Follow) continua à parte: seguir é unilateral, amizade é mútua.
// ─────────────────────────────────────────────────────────────────
const prisma = require('../config/database');
const logger = require('../utils/logger');
const blockSvc = require('../services/blockService');
const notifSvc = require('../services/notificationService');
const friendSvc = require('../services/friendService');
const { ok, badRequest, notFound, forbidden, serverError } = require('../utils/response');

const MAX_PENDING_SENT = 100;   // contra spam de pedidos
const PERSON_SELECT = {
  id: true, name: true, username: true, avatarUrl: true, isPremium: true, verifiedSeller: true, active: true,
  bazar: { select: { id: true, name: true, slug: true } }
};
const person = (u) => (u ? {
  id: u.id, name: u.name, username: u.username || null, avatarUrl: u.avatarUrl || null,
  isPremium: !!u.isPremium, verified: !!u.verifiedSeller,
  bazar: u.bazar ? { id: u.bazar.id, name: u.bazar.name, slug: u.bazar.slug } : null
} : null);

const pageParams = (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 50);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};
const meta = (total, page, limit) => ({ total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total });

// GET /friends — os meus amigos
const list = async (req, res) => {
  try {
    const me = req.user.id;
    const { limit, page, skip } = pageParams(req.query);
    const where = { status: 'ACCEPTED', OR: [{ requesterId: me }, { addresseeId: me }] };
    const [rows, total] = await Promise.all([
      prisma.friendship.findMany({
        where, orderBy: { respondedAt: 'desc' }, take: limit, skip,
        include: { requester: { select: PERSON_SELECT }, addressee: { select: PERSON_SELECT } }
      }),
      prisma.friendship.count({ where })
    ]);
    const items = rows
      .map((r) => ({ friendshipId: r.id, since: r.respondedAt || r.createdAt, ...person(r.requesterId === me ? r.addressee : r.requester) }))
      .filter((f) => f.id);
    return ok(res, { items, meta: meta(total, page, limit) });
  } catch (err) {
    logger.error(`[Friends.list] ${err.message}`);
    return serverError(res);
  }
};

// GET /friends/summary — contadores (separadores e distintivo)
const summary = async (req, res) => {
  try {
    const me = req.user.id;
    const [friends, received, sent] = await Promise.all([
      prisma.friendship.count({ where: { status: 'ACCEPTED', OR: [{ requesterId: me }, { addresseeId: me }] } }),
      prisma.friendship.count({ where: { status: 'PENDING', addresseeId: me } }),
      prisma.friendship.count({ where: { status: 'PENDING', requesterId: me } })
    ]);
    return ok(res, { friends, received, sent });
  } catch (err) {
    logger.error(`[Friends.summary] ${err.message}`);
    return serverError(res);
  }
};

// GET /friends/requests?box=received|sent
const requests = async (req, res) => {
  try {
    const me = req.user.id;
    const box = req.query.box === 'sent' ? 'sent' : 'received';
    const { limit, page, skip } = pageParams(req.query);
    const where = box === 'sent' ? { status: 'PENDING', requesterId: me } : { status: 'PENDING', addresseeId: me };
    const [rows, total] = await Promise.all([
      prisma.friendship.findMany({
        where, orderBy: { createdAt: 'desc' }, take: limit, skip,
        include: { requester: { select: PERSON_SELECT }, addressee: { select: PERSON_SELECT } }
      }),
      prisma.friendship.count({ where })
    ]);
    const items = rows
      .map((r) => ({ friendshipId: r.id, createdAt: r.createdAt, ...person(box === 'sent' ? r.addressee : r.requester) }))
      .filter((f) => f.id);
    return ok(res, { box, items, meta: meta(total, page, limit) });
  } catch (err) {
    logger.error(`[Friends.requests] ${err.message}`);
    return serverError(res);
  }
};

// GET /friends/status/:userId
const status = async (req, res) => {
  try {
    const me = req.user.id;
    const other = req.params.userId;
    if (other === me) return ok(res, { status: 'SELF' });
    const rel = (await friendSvc.relationMap(me, [other]))[other];
    return ok(res, rel ? rel : { status: 'NONE', friendshipId: null });
  } catch (err) {
    logger.error(`[Friends.status] ${err.message}`);
    return serverError(res);
  }
};

// GET /friends/search?q=
const search = async (req, res) => {
  try {
    const me = req.user.id;
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return ok(res, { items: [] });
    const hidden = await blockSvc.getHiddenUserIds(me).catch(() => new Set());
    const users = await prisma.user.findMany({
      where: {
        id: { not: me, ...(hidden.size ? { notIn: [...hidden] } : {}) },
        active: true,
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { username: { contains: q.replace(/^@/, ''), mode: 'insensitive' } }]
      },
      select: PERSON_SELECT, take: 20, orderBy: { name: 'asc' }
    });
    const rel = await friendSvc.relationMap(me, users.map((u) => u.id));
    return ok(res, { items: users.map((u) => ({ ...person(u), relation: rel[u.id] || { status: 'NONE', friendshipId: null } })) });
  } catch (err) {
    logger.error(`[Friends.search] ${err.message}`);
    return serverError(res);
  }
};

// GET /friends/suggestions — amigos de amigos (por nº de amigos em comum) e, para completar, contas activas com loja
const suggestions = async (req, res) => {
  try {
    const me = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
    const [myFriends, hidden, mine] = await Promise.all([
      friendSvc.friendIdsOf(me),
      blockSvc.getHiddenUserIds(me).catch(() => new Set()),
      prisma.friendship.findMany({ where: { OR: [{ requesterId: me }, { addresseeId: me }] }, select: { requesterId: true, addresseeId: true }, take: 1000 })
    ]);
    const exclude = new Set([me, ...hidden]);
    mine.forEach((r) => { exclude.add(r.requesterId); exclude.add(r.addresseeId); });

    const mutual = new Map();
    if (myFriends.length) {
      const fof = await prisma.friendship.findMany({
        where: { status: 'ACCEPTED', OR: [{ requesterId: { in: myFriends } }, { addresseeId: { in: myFriends } }] },
        select: { requesterId: true, addresseeId: true }, take: 2000
      });
      const mySet = new Set(myFriends);
      for (const r of fof) {
        const cand = mySet.has(r.requesterId) ? r.addresseeId : r.requesterId;
        if (exclude.has(cand) || mySet.has(cand)) continue;
        mutual.set(cand, (mutual.get(cand) || 0) + 1);
      }
    }
    const rankedIds = [...mutual.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);

    let users = rankedIds.length
      ? await prisma.user.findMany({ where: { id: { in: rankedIds }, active: true }, select: PERSON_SELECT })
      : [];
    users.sort((a, b) => (mutual.get(b.id) || 0) - (mutual.get(a.id) || 0));

    if (users.length < limit) {
      const have = new Set(users.map((u) => u.id));
      const filler = await prisma.user.findMany({
        where: { active: true, bazar: { isNot: null }, id: { notIn: [...exclude, ...have] } },
        select: PERSON_SELECT, orderBy: { createdAt: 'desc' }, take: limit - users.length
      });
      users = users.concat(filler);
    }
    return ok(res, { items: users.map((u) => ({ ...person(u), mutual: mutual.get(u.id) || 0 })) });
  } catch (err) {
    logger.error(`[Friends.suggestions] ${err.message}`);
    return serverError(res);
  }
};

// POST /friends/request/:userId
const request = async (req, res) => {
  try {
    const me = req.user.id;
    const target = req.params.userId;
    if (target === me) return badRequest(res, 'Não podes adicionar-te a ti próprio.');
    const user = await prisma.user.findUnique({ where: { id: target }, select: { id: true, active: true } });
    if (!user || !user.active) return notFound(res, 'Utilizador não encontrado.');
    if (await blockSvc.isBlockedEither(me, target)) return forbidden(res, 'Não é possível enviar o pedido a este utilizador.');

    const existing = await prisma.friendship.findFirst({
      where: { OR: [{ requesterId: me, addresseeId: target }, { requesterId: target, addresseeId: me }] }
    });
    if (existing) {
      if (existing.status === 'ACCEPTED') return ok(res, { status: 'FRIENDS', friendshipId: existing.id });
      if (existing.requesterId === me) return ok(res, { status: 'REQUEST_SENT', friendshipId: existing.id }); // idempotente
      // O outro já te tinha pedido: pedir de volta = aceitar.
      const accepted = await prisma.friendship.updateMany({ where: { id: existing.id, status: 'PENDING' }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
      if (accepted.count) notifSvc.friendAccepted(target, req.user.name, me).catch(() => {});
      return ok(res, { status: 'FRIENDS', friendshipId: existing.id });
    }

    const pendingSent = await prisma.friendship.count({ where: { requesterId: me, status: 'PENDING' } });
    if (pendingSent >= MAX_PENDING_SENT) {
      return badRequest(res, `Já tens ${pendingSent} pedidos por responder. Aguarda que sejam aceites ou cancela alguns.`);
    }
    let row;
    try {
      row = await prisma.friendship.create({ data: { requesterId: me, addresseeId: target } });
    } catch (err) {
      if (err.code !== 'P2002') throw err; // dois cliques rápidos: o pedido já existe
      row = await prisma.friendship.findFirst({ where: { requesterId: me, addresseeId: target } });
    }
    notifSvc.friendRequest(target, req.user.name, me).catch(() => {});
    return ok(res, { status: 'REQUEST_SENT', friendshipId: row?.id || null });
  } catch (err) {
    logger.error(`[Friends.request] ${err.message}`);
    return serverError(res);
  }
};

// POST /friends/:id/accept — só quem recebeu o pedido
const accept = async (req, res) => {
  try {
    const me = req.user.id;
    const row = await prisma.friendship.findFirst({ where: { id: req.params.id, addresseeId: me } });
    if (!row) return notFound(res, 'Pedido não encontrado.');
    if (row.status === 'ACCEPTED') return ok(res, { status: 'FRIENDS', friendshipId: row.id });
    if (await blockSvc.isBlockedEither(me, row.requesterId)) return forbidden(res, 'Não é possível aceitar este pedido.');
    const upd = await prisma.friendship.updateMany({ where: { id: row.id, addresseeId: me, status: 'PENDING' }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
    if (upd.count) notifSvc.friendAccepted(row.requesterId, req.user.name, me).catch(() => {});
    return ok(res, { status: 'FRIENDS', friendshipId: row.id });
  } catch (err) {
    logger.error(`[Friends.accept] ${err.message}`);
    return serverError(res);
  }
};

// POST /friends/:id/decline — só quem recebeu o pedido; apaga (não se guarda "rejeitado")
const decline = async (req, res) => {
  try {
    await prisma.friendship.deleteMany({ where: { id: req.params.id, addresseeId: req.user.id, status: 'PENDING' } });
    return ok(res, { status: 'NONE' });
  } catch (err) {
    logger.error(`[Friends.decline] ${err.message}`);
    return serverError(res);
  }
};

// DELETE /friends/:id — cancelar o pedido que enviei, ou desfazer uma amizade (qualquer das partes)
const remove = async (req, res) => {
  try {
    const me = req.user.id;
    await prisma.friendship.deleteMany({ where: { id: req.params.id, OR: [{ requesterId: me }, { addresseeId: me }] } });
    return ok(res, { status: 'NONE' });
  } catch (err) {
    logger.error(`[Friends.remove] ${err.message}`);
    return serverError(res);
  }
};

// DELETE /friends/with/:userId — o mesmo, quando só se conhece o utilizador (botão na loja/pesquisa)
const removeWith = async (req, res) => {
  try {
    const me = req.user.id;
    const other = req.params.userId;
    await prisma.friendship.deleteMany({
      where: { OR: [{ requesterId: me, addresseeId: other }, { requesterId: other, addresseeId: me }] }
    });
    return ok(res, { status: 'NONE' });
  } catch (err) {
    logger.error(`[Friends.removeWith] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, summary, requests, status, search, suggestions, request, accept, decline, remove, removeWith };
