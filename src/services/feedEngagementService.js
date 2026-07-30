'use strict';

const prisma = require('../config/database');

const VALID_TYPES = ['PRODUCT', 'ANNOUNCEMENT', 'REEL'];

/**
 * Junta contagens de reações/partilhas/comentários e a reação do
 * próprio utilizador a uma lista de itens { targetType, targetId, ... }.
 * Usado pelo feed (Home) e por qualquer listagem de produtos que
 * queira mostrar os mesmos números — mesma lógica, um único sítio,
 * para os números nunca ficarem diferentes consoante a página.
 *
 * Devolve os itens originais com os campos extra juntos a seguir:
 * likeCount, dislikeCount, shareCount, commentCount, myReaction, sharedByMe.
 */
const attachEngagement = async (items, userId) => {
  if (items.length === 0) return items;
  const byType = { PRODUCT: [], ANNOUNCEMENT: [], REEL: [] };
  items.forEach((it) => byType[it.targetType].push(it.targetId));
  const activeTypes = VALID_TYPES.filter((t) => byType[t].length);
  if (activeTypes.length === 0) return items;

  const [reactions, shares, comments, myReactions, myShares] = await Promise.all([
    prisma.feedReaction.groupBy({
      by: ['targetType', 'targetId', 'value'],
      where: { OR: activeTypes.map((t) => ({ targetType: t, targetId: { in: byType[t] } })) },
      _count: true
    }),
    prisma.feedShare.groupBy({
      by: ['targetType', 'targetId'],
      where: { OR: activeTypes.map((t) => ({ targetType: t, targetId: { in: byType[t] } })) },
      _count: true
    }),
    prisma.comment.groupBy({
      by: ['productId', 'announcementId', 'reelId'],
      where: { OR: [{ productId: { in: byType.PRODUCT } }, { announcementId: { in: byType.ANNOUNCEMENT } }, { reelId: { in: byType.REEL } }] },
      _count: true
    }),
    userId ? prisma.feedReaction.findMany({ where: { userId, OR: activeTypes.map((t) => ({ targetType: t, targetId: { in: byType[t] } })) } }) : [],
    userId ? prisma.feedShare.findMany({ where: { userId, OR: activeTypes.map((t) => ({ targetType: t, targetId: { in: byType[t] } })) } }) : []
  ]);

  const key = (t, id) => `${t}:${id}`;
  const likeMap = {}, dislikeMap = {}, shareMap = {}, commentMap = {};
  reactions.forEach((r) => {
    const k = key(r.targetType, r.targetId);
    if (r.value === 1) likeMap[k] = r._count;
    if (r.value === -1) dislikeMap[k] = r._count;
  });
  shares.forEach((s) => { shareMap[key(s.targetType, s.targetId)] = s._count; });
  comments.forEach((c) => {
    if (c.productId) commentMap[key('PRODUCT', c.productId)] = c._count;
    if (c.announcementId) commentMap[key('ANNOUNCEMENT', c.announcementId)] = c._count;
    if (c.reelId) commentMap[key('REEL', c.reelId)] = c._count;
  });
  const myReactionMap = {};
  myReactions.forEach((r) => { myReactionMap[key(r.targetType, r.targetId)] = r.value; });
  const mySharedSet = new Set(myShares.map((s) => key(s.targetType, s.targetId)));

  return items.map((it) => {
    const k = key(it.targetType, it.targetId);
    return {
      ...it,
      likeCount: likeMap[k] || 0,
      dislikeCount: dislikeMap[k] || 0,
      shareCount: shareMap[k] || 0,
      commentCount: commentMap[k] || 0,
      myReaction: myReactionMap[k] || 0,
      sharedByMe: mySharedSet.has(k)
    };
  });
};

/**
 * Conveniência para listagens "normais" (não itens de feed): recebe um
 * array de itens (cada um com .id) e devolve os mesmos itens com
 * likeCount/dislikeCount/shareCount/commentCount/myReaction anexados
 * directamente — sem embrulhar em targetType/Id.
 */
const attachDirectEngagement = async (list, userId, targetType) => {
  if (!list || list.length === 0) return list;
  const wrapped = list.map((it) => ({ targetType, targetId: it.id }));
  const withEngagement = await attachEngagement(wrapped, userId);
  return list.map((it, i) => ({
    ...it,
    likeCount: withEngagement[i].likeCount,
    dislikeCount: withEngagement[i].dislikeCount,
    shareCount: withEngagement[i].shareCount,
    commentCount: withEngagement[i].commentCount,
    myReaction: withEngagement[i].myReaction
  }));
};

const attachProductEngagement = (products, userId) => attachDirectEngagement(products, userId, 'PRODUCT');
const attachReelEngagement = (reels, userId) => attachDirectEngagement(reels, userId, 'REEL');

// Anexa bazar.isFollowing a uma lista de itens que tragam .bazar.id
// (reels/produtos do feed global) — para o botão "Seguir" já nascer
// no estado certo, sem precisar de um pedido extra por cartão.
const attachFollowState = async (items, userId) => {
  if (!userId || !items.length) return items;
  const bazarIds = [...new Set(items.map((it) => it.bazar?.id).filter(Boolean))];
  if (!bazarIds.length) return items;
  const follows = await prisma.follow.findMany({ where: { userId, bazarId: { in: bazarIds } }, select: { bazarId: true } });
  const followedSet = new Set(follows.map((f) => f.bazarId));
  return items.map((it) => it.bazar ? { ...it, bazar: { ...it.bazar, isFollowing: followedSet.has(it.bazar.id) } } : it);
};

module.exports = { attachEngagement, attachProductEngagement, attachReelEngagement, attachDirectEngagement, attachFollowState, VALID_TYPES };
