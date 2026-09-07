'use strict';

const prisma = require('../config/database');
const notifSvc = require('./notificationService');
const blockService = require('./blockService');

const USER_SELECT = { id: true, name: true, avatarUrl: true, isPremium: true };

/**
 * Lista comentários de topo (parentId = null) de um alvo, com as
 * respostas já embutidas (máx. 3 por comentário — "ver mais respostas"
 * carrega o resto à parte) e a contagem/estado de gosto de cada um.
 * `where` identifica o alvo (productId/announcementId/reelId).
 */
const listThreaded = async (where, userId, { take, skip } = {}) => {
  // Esconde comentários de quem bloqueaste (ou de quem te bloqueou), nos
  // dois sentidos — antes disto, o feed principal já aplicava isto
  // (feedController), mas comentários em produtos/anúncios/reels não
  // aplicavam nada: bloquear alguém não garantia deixar de ver os
  // comentários dessa pessoa, nem impedia que ela continuasse a ver os
  // teus.
  const hiddenIds = userId ? await blockService.getHiddenUserIds(userId) : new Set();
  const blockFilter = hiddenIds.size ? { userId: { notIn: [...hiddenIds] } } : {};

  const [topLevel, total] = await Promise.all([
    prisma.comment.findMany({
      where: { ...where, ...blockFilter, parentId: null },
      take, skip,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: USER_SELECT },
        mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } },
        _count: { select: { likes: true, replies: true } }
      }
    }),
    prisma.comment.count({ where: { ...where, ...blockFilter, parentId: null } })
  ]);

  const topIds = topLevel.map((c) => c.id);
  const [replies, myLikes] = await Promise.all([
    topIds.length
      ? prisma.comment.findMany({
          where: { parentId: { in: topIds }, ...blockFilter },
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: USER_SELECT },
            mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } },
            _count: { select: { likes: true } }
          }
        })
      : [],
    userId
      ? prisma.commentLike.findMany({
          where: { userId, comment: { OR: [{ id: { in: topIds } }, { parentId: { in: topIds } }] } },
          select: { commentId: true }
        })
      : []
  ]);

  const likedSet = new Set(myLikes.map((l) => l.commentId));
  const repliesByParent = {};
  replies.forEach((r) => {
    if (!repliesByParent[r.parentId]) repliesByParent[r.parentId] = [];
    repliesByParent[r.parentId].push({
      ...r,
      likeCount: r._count.likes,
      likedByMe: likedSet.has(r.id),
      _count: undefined
    });
  });

  const comments = topLevel.map((c) => ({
    ...c,
    likeCount: c._count.likes,
    replyCount: c._count.replies,
    likedByMe: likedSet.has(c.id),
    replies: (repliesByParent[c.id] || []).slice(0, 3),
    _count: undefined
  }));

  return { comments, total };
};

const listReplies = async (parentId, userId, { take, skip } = {}) => {
  // Mesma regra de bloqueio aplicada em listThreaded.
  const hiddenIds = userId ? await blockService.getHiddenUserIds(userId) : new Set();
  const blockFilter = hiddenIds.size ? { userId: { notIn: [...hiddenIds] } } : {};

  const [replies, total] = await Promise.all([
    prisma.comment.findMany({
      where: { parentId, ...blockFilter },
      take, skip,
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: USER_SELECT },
        mentions: { select: { mentionedUserId: true, mentionedUser: { select: { username: true } } } },
        _count: { select: { likes: true } }
      }
    }),
    prisma.comment.count({ where: { parentId, ...blockFilter } })
  ]);
  const myLikes = userId
    ? await prisma.commentLike.findMany({ where: { userId, commentId: { in: replies.map((r) => r.id) } }, select: { commentId: true } })
    : [];
  const likedSet = new Set(myLikes.map((l) => l.commentId));
  const items = replies.map((r) => ({ ...r, likeCount: r._count.likes, likedByMe: likedSet.has(r.id), _count: undefined }));
  return { replies: items, total };
};

// Alterna o gosto num comentário — devolve { liked, likeCount }.
const toggleLike = async (commentId, userId) => {
  const existing = await prisma.commentLike.findUnique({
    where: { userId_commentId: { userId, commentId } }
  });
  if (existing) {
    try {
      await prisma.commentLike.delete({ where: { id: existing.id } });
    } catch (err) {
      if (err.code !== 'P2025') throw err; // já removido por pedido concorrente
    }
  } else {
    try {
      await prisma.commentLike.create({ data: { userId, commentId } });
      notifyCommentLiked(commentId, userId).catch(() => {});
    } catch (err) {
      if (err.code !== 'P2002') throw err; // já criado por pedido concorrente — idempotente
    }
  }
  const likeCount = await prisma.commentLike.count({ where: { commentId } });
  return { liked: !existing, likeCount };
};

const notifyCommentLiked = async (commentId, likerId) => {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      userId: true, text: true,
      productId: true, product: { select: { slug: true } },
      announcementId: true, reelId: true
    }
  });
  if (!comment || comment.userId === likerId) return;
  const liker = await prisma.user.findUnique({ where: { id: likerId }, select: { name: true } });
  const link = comment.productId ? `product.html?id=${comment.product?.slug || comment.productId}`
    : comment.announcementId ? `home.html?announcement=${comment.announcementId}`
    : `reels.html?reel=${comment.reelId}`;
  await notifSvc.commentLiked(comment.userId, liker?.name || 'Alguém', comment.text, link);
};

module.exports = { listThreaded, listReplies, toggleLike, USER_SELECT };
