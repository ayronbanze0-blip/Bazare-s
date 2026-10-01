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

// Versão para LEITURAS (listas/feeds): se a consulta falhar, regista e segue sem filtrar, em vez de
// deitar abaixo o ecrã. Contrapartida: nesse intervalo podem aparecer itens de utilizadores bloqueados.
// Não usar em escritas (menções, mensagens) — aí usa-se a versão estrita acima.
async function getHiddenUserIdsSafe(userId) {
  try { return await getHiddenUserIds(userId); }
  catch (err) {
    require('../utils/logger').error(`[Block] etapa "bloqueios" falhou (a continuar sem filtrar): ${err.code ? err.code + ' · ' : ''}${err.message}`);
    return new Set();
  }
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

// ─── Dos `otherIds` dados, devolve os que têm bloqueio com userId (qualquer
// sentido) — UMA query, para verificar vários vendedores/autores de uma vez.
async function blockedAmong(userId, otherIds = []) {
  if (!userId || !otherIds.length) return [];
  const hidden = await getHiddenUserIds(userId);
  return otherIds.filter((id) => hidden.has(id));
}

module.exports = { getHiddenUserIds, getHiddenUserIdsSafe, isBlockedEither, blockedAmong };
