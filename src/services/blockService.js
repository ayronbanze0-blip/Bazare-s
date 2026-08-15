'use strict';

const prisma = require('../config/database');

// ─── Devolve o conjunto de ids "invisíveis" para userId ───────────────
// Inclui quem userId bloqueou E quem bloqueou userId — um bloqueio
// esconde nos dois sentidos (como Instagram/Facebook), para que a
// pessoa bloqueada também deixe de ver o conteúdo de quem a bloqueou.
async function getHiddenUserIds(userId) {
  if (!userId) return new Set();
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true }
  });
  const ids = new Set();
  for (const r of rows) {
    ids.add(r.blockerId === userId ? r.blockedId : r.blockerId);
  }
  return ids;
}

// ─── Verifica se existe bloqueio entre dois utilizadores, em qualquer
// sentido — usado no chat para impedir enviar/receber mensagens. ──────
async function isBlockedEither(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA }
      ]
    },
    select: { id: true }
  });
  return !!block;
}

module.exports = { getHiddenUserIds, isBlockedEither };
