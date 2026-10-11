'use strict';

// Amizade mútua (pedido → aceitar). Funções partilhadas pelo controlador e pelo feed.
const prisma = require('../config/database');

/** IDs dos amigos (amizades ACCEPTED, nos dois sentidos) de um utilizador. */
const friendIdsOf = async (userId, take = 500) => {
  if (!userId) return [];
  const rows = await prisma.friendship.findMany({
    where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    select: { requesterId: true, addresseeId: true },
    take
  });
  return [...new Set(rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId)))];
};

/**
 * Relação de `me` com cada um dos `otherIds`:
 *   { [id]: { status: 'FRIENDS'|'REQUEST_SENT'|'REQUEST_RECEIVED', friendshipId } } (ausente = sem relação)
 */
const relationMap = async (me, otherIds) => {
  const out = {};
  if (!me || !otherIds.length) return out;
  const rows = await prisma.friendship.findMany({
    where: {
      OR: [
        { requesterId: me, addresseeId: { in: otherIds } },
        { addresseeId: me, requesterId: { in: otherIds } }
      ]
    },
    select: { id: true, requesterId: true, addresseeId: true, status: true }
  });
  for (const r of rows) {
    const other = r.requesterId === me ? r.addresseeId : r.requesterId;
    const status = r.status === 'ACCEPTED' ? 'FRIENDS' : (r.requesterId === me ? 'REQUEST_SENT' : 'REQUEST_RECEIVED');
    // Se houver linhas nos dois sentidos (pedidos cruzados), a amizade aceite ganha.
    if (!out[other] || status === 'FRIENDS') out[other] = { status, friendshipId: r.id };
  }
  return out;
};

module.exports = { friendIdsOf, relationMap };
