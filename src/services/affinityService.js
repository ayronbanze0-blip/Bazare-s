'use strict';

// ─── Feed inteligente: afinidade por Bazar ────────────────────────
// Cada interação positiva (ver, gostar, comentar, partilhar, seguir,
// guardar) soma pontos à relação (utilizador, bazar). Isto NÃO decide
// que conteúdo entra numa página do feed — isso continua a ser só por
// data (feedController.list/reelController.listGlobal) para não
// quebrar a paginação por cursor. Serve só para reordenar, dentro de
// cada página já buscada, o que aparece primeiro — ver applyAffinityOrder.
const prisma = require('../config/database');
const logger = require('../utils/logger');

const WEIGHTS = {
  VIEW: 1,       // abriu o produto/loja
  FAVORITE: 3,   // guardou um produto
  REACT: 5,      // reagiu (qualquer uma das 7 reações)
  SHARE: 4,      // partilhou
  COMMENT: 6,    // comentou
  FOLLOW: 8      // começou a seguir a loja
};

// Fire-and-forget — nunca deve atrasar nem partir o pedido principal
// que despoletou a interação, por isso quem chama nunca faz `await`
// nem trata o erro (ver `.catch(()=>{})` nos pontos de chamada).
async function bump(userId, bazarId, kind) {
  if (!userId || !bazarId) return;
  const delta = WEIGHTS[kind];
  if (!delta) return;
  try {
    await prisma.userAffinity.upsert({
      where: { userId_bazarId: { userId, bazarId } },
      update: { score: { increment: delta } },
      create: { userId, bazarId, score: delta }
    });
  } catch (err) {
    logger.error(`[Affinity.bump] ${err.message}`);
  }
}

// Devolve { bazarId: score } só para os bazares pedidos — chamado com
// a lista de bazares já presentes numa página do feed, nunca a tabela
// toda de uma vez.
async function getScores(userId, bazarIds) {
  const ids = [...new Set((bazarIds || []).filter(Boolean))];
  if (!userId || !ids.length) return new Map();
  try {
    const rows = await prisma.userAffinity.findMany({
      where: { userId, bazarId: { in: ids } },
      select: { bazarId: true, score: true }
    });
    return new Map(rows.map(r => [r.bazarId, r.score]));
  } catch (err) {
    logger.error(`[Affinity.getScores] ${err.message}`);
    return new Map();
  }
}

// Reordena uma página JÁ DECIDIDA do feed (mesmo conjunto de itens,
// já cortado por data/cursor) — nunca acrescenta nem remove itens,
// só troca a ordem de exibição. `getBazarId(item)` diz de que bazar é
// cada item; itens sem afinidade nenhuma mantêm-se pela ordem original
// (mais recente primeiro) entre si — só "sobem" os que já mostraram
// interesse nalgum bazar presente nesta página.
async function applyAffinityOrder(items, userId, getBazarId) {
  if (!userId || items.length < 2) return items;
  const bazarIds = items.map(getBazarId);
  const scores = await getScores(userId, bazarIds);
  if (!scores.size) return items; // sem histórico ainda — não mexe em nada (cold start)

  // Índice de recência preserva o desempate: só a posição relativa
  // dentro do grupo "mesma afinidade" é que reflecte a ordem original.
  return items
    .map((it, i) => ({ it, i, boost: scores.get(getBazarId(it)) || 0 }))
    .sort((a, b) => (b.boost - a.boost) || (a.i - b.i))
    .map(x => x.it);
}

module.exports = { bump, getScores, applyAffinityOrder };
