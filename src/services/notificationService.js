'use strict';

const logger = require('../utils/logger');
const pushService = require('./pushService');
const policy = require('./notificationPolicy');
const { shouldCount } = require('../utils/dedupWindow');

let prismaClient;
let ioClient;

const init = (prisma, io) => {
  prismaClient = prisma;
  ioClient = io;
};

// ─── Preferências do utilizador ─────────────────────────────────────
// Cache curta em memória (30 s) — push() é chamado com muita frequência e não deve fazer uma
// query extra por cada notificação. Fail-open: se a tabela não existir (migration por aplicar)
// ou a BD falhar, aplicam-se as preferências por omissão (tudo ligado) — nunca se perde uma
// notificação por causa das preferências.
const PREF_TTL_MS = 30 * 1000;
const PREF_CACHE_MAX = 5000;
const prefCache = new Map(); // userId -> { prefs|null, at }

const getPrefs = async (userId) => {
  const hit = prefCache.get(userId);
  if (hit && Date.now() - hit.at < PREF_TTL_MS) return hit.prefs;
  let prefs = null;
  try {
    prefs = await prismaClient.notificationPreference.findUnique({ where: { userId } });
  } catch { /* tabela em falta / BD indisponível → omissões */ }
  if (prefCache.size >= PREF_CACHE_MAX) prefCache.clear();
  prefCache.set(userId, { prefs, at: Date.now() });
  return prefs;
};

/** Pré-carrega as preferências de vários utilizadores com UMA query (broadcasts / seguidores). */
const warmPrefs = async (userIds) => {
  if (!prismaClient || !userIds.length) return;
  try {
    const rows = await prismaClient.notificationPreference.findMany({ where: { userId: { in: userIds } } });
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const now = Date.now();
    if (prefCache.size + userIds.length >= PREF_CACHE_MAX) prefCache.clear();
    for (const id of userIds) prefCache.set(id, { prefs: byUser.get(id) || null, at: now });
  } catch { /* fail-open */ }
};

const invalidatePrefs = (userId) => prefCache.delete(userId);

/** Deve enviar email a este utilizador para esta categoria? (respeita emailEnabled + categoria) */
const shouldEmail = async (userId, category) => {
  if (!prismaClient) return true;
  return policy.allowedEmail(await getPrefs(userId), category);
};

/**
 * Create a notification and emit via Socket.IO
 *
 * Opções extra (todas opcionais, retrocompatíveis):
 *   category  'orders'|'messages'|'social'|'marketing'|'system' (por omissão deriva do `type`)
 *   collapse  true → em vez de criar outra, actualiza a notificação NÃO LIDA mais recente do mesmo
 *             tipo/título/link (ex.: 10 mensagens do mesmo chat = 1 notificação com a última)
 * Respeita as preferências (in-app / push) e evita duplicados de SOCIAL (10 min).
 */
const push = async (userId, { type = 'INFO', title, message, link = null, category, collapse = false }) => {
  if (!prismaClient) { logger.warn('[Notif] Prisma not initialized'); return null; }
  try {
    const cat = category || policy.categoryFor(type);
    const prefs = await getPrefs(userId);
    if (!policy.allowedInApp(prefs, cat)) return null; // desligada pelo utilizador

    // Deduplicação: o mesmo evento social repetido (gosto/desgosto/gosto…) não gera spam.
    if (type === 'SOCIAL' && !shouldCount('notif-dedupe', userId, `${type}|${title}|${link}|${message}`, 10 * 60 * 1000)) {
      return null;
    }

    let notif = null;
    if (collapse) {
      const existing = await prismaClient.notification.findFirst({
        where: { userId, read: false, type, title, link, createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
      });
      if (existing) {
        notif = await prismaClient.notification.update({ where: { id: existing.id }, data: { message, createdAt: new Date() } });
      }
    }
    if (!notif) {
      notif = await prismaClient.notification.create({ data: { userId, type, title, message, link } });
    }

    // Emit real-time via Socket.IO
    if (ioClient) {
      ioClient.to(`user:${userId}`).emit('notification', {
        id: notif.id,
        type: notif.type,
        title: notif.title,
        message: notif.message,
        link: notif.link,
        read: false,
        createdAt: notif.createdAt
      });
    }
    // Push nativo (FCM) — "fire and forget": não bloqueia nem faz
    // falhar o resto do fluxo (ex.: criação da encomenda) se a
    // Firebase estiver indisponível ou não configurada.
    if (policy.allowedPush(prefs, cat)) {
      pushService.sendToUser(prismaClient, userId, { title, body: message, link }).catch(() => {});
    }
    return notif;
  } catch (err) {
    logger.error(`[Notif] Failed to push for user ${userId}: ${err.message}`);
    return null;
  }
};

/**
 * Common notification helpers
 */
const orderReceived = (sellerId, orderId, productName, total) =>
  push(sellerId, {
    type: 'ORDER',
    title: 'Nova encomenda recebida',
    message: `${productName} — ${total.toLocaleString('pt-MZ')} MT`,
    // Rota real do frontend (MPA, não React Router) — "/orders/:id" nunca
    // existiu como página; o clique na notificação não ia a lugar nenhum.
    link: `order-detail.html?id=${orderId}`
  });

const orderStatusChanged = (buyerId, orderId, status) =>
  push(buyerId, {
    type: 'ORDER',
    title: `Encomenda ${status.toLowerCase()}`,
    message: `A sua encomenda #${orderId.slice(-8)} foi ${status.toLowerCase()}.`,
    link: `order-detail.html?id=${orderId}`
  });

const newMessage = (toId, fromName, preview, chatId = null) =>
  push(toId, {
    type: 'CHAT',
    title: `Mensagem de ${fromName}`,
    message: preview.slice(0, 80),
    // Com chatId abre já a conversa certa; sem ele (ex.: resposta a
    // história, onde o utilizador que recebe pode não ter ainda uma
    // entrada visível) cai na lista de conversas.
    link: chatId ? `chat.html?chatId=${chatId}` : 'chat.html',
    collapse: true // várias mensagens seguidas do mesmo chat = 1 notificação (a mais recente)
  });

const feeAlert = (sellerId, amount) =>
  push(sellerId, {
    type: 'WARNING',
    title: 'Contribuição pendente',
    message: `A sua contribuição atingiu ${amount.toLocaleString('pt-MZ')} MT. Efectue o pagamento.`,
    link: 'finance.html'
  });

const accountSuspended = (userId, reason) =>
  push(userId, {
    type: 'ERROR',
    title: 'Conta suspensa',
    message: reason || 'A sua conta foi suspensa. Contacte o suporte.',
    link: 'support.html'
  });

const accountVerified = (userId) =>
  push(userId, {
    type: 'SUCCESS',
    title: 'Conta verificada!',
    message: 'A sua conta de vendedor foi verificada pela plataforma.',
    link: 'profile.html'
  });

/**
 * Avisa todos os seguidores de um bazar quando um produto novo é
 * publicado. Fire-and-forget do lado de quem chama — aqui dentro
 * cada notificação individual também não deve travar as outras se
 * uma falhar (ex.: token push inválido de um utilizador).
 */
const newProductFromFollowed = async (bazarId, sellerName, productName) => {
  if (!prismaClient) return;
  try {
    const followers = await prismaClient.follow.findMany({
      where: { bazarId },
      select: { userId: true }
    });
    if (followers.length === 0) return;
    await warmPrefs(followers.map((f) => f.userId));
    await Promise.all(followers.map((f) =>
      push(f.userId, {
        type: 'INFO',
        category: 'social',
        title: `${sellerName} publicou um novo produto`,
        message: productName,
        link: `bazar.html?id=${bazarId}`
      }).catch(() => {})
    ));
  } catch (err) {
    logger.error(`[Notif] newProductFromFollowed falhou: ${err.message}`);
  }
};

/**
 * "Produto voltou ao stock" — avisa quem tem o produto nos favoritos (máx. 200).
 * Chamado quando o stock passa de 0 para > 0. No máximo 1 vez por produto a cada 6 h
 * (evita spam se o vendedor alternar esgotado/disponível).
 */
const backInStock = async (productId, productName) => {
  if (!prismaClient) return;
  try {
    if (!shouldCount('back-in-stock', productId, 'all', 6 * 60 * 60 * 1000)) return;
    const favs = await prismaClient.favorite.findMany({
      where: { productId }, select: { userId: true }, take: 200
    });
    if (!favs.length) return;
    await warmPrefs(favs.map((f) => f.userId));
    await Promise.all(favs.map((f) => push(f.userId, {
      type: 'INFO', category: 'orders',
      title: 'Produto de volta ao stock',
      message: `"${productName}" já está novamente disponível.`,
      link: `product.html?id=${productId}`
    }).catch(() => {})));
  } catch (err) {
    logger.error(`[Notif] backInStock falhou: ${err.message}`);
  }
};

const broadcastToRole = async (role, notification) => {
  if (!prismaClient) return;
  try {
    const users = await prismaClient.user.findMany({
      where: { role, active: true },
      select: { id: true }
    });
    await warmPrefs(users.map((u) => u.id));
    await Promise.all(users.map(u => push(u.id, { category: 'marketing', ...notification })));
  } catch (err) {
    logger.error(`[Notif] Broadcast failed: ${err.message}`);
  }
};

// ─────────────────────────────────────────────
// ACTIVIDADE SOCIAL (seguir, comentar, responder, gostar de comentário)
// ─────────────────────────────────────────────
const newFollower = (sellerId, followerName, bazarId, followerId) => {
  // Dedup: follow/unfollow/follow repetido (toque acidental, indeciso,
  // ou alguém a "testar" o botão) não deve gerar uma notificação por
  // cada vez — só uma por par (seguidor, bazar) a cada 10 minutos.
  if (followerId && !shouldCount('notif-follow', followerId, bazarId, 10 * 60 * 1000)) return;
  return push(sellerId, {
    type: 'SOCIAL',
    title: 'Novo seguidor',
    message: `${followerName} começou a seguir o teu bazar.`,
    link: `bazar.html?id=${bazarId}`
  });
};

const commentOnContent = (ownerId, commenterName, snippet, link) =>
  push(ownerId, {
    type: 'SOCIAL',
    title: `${commenterName} comentou`,
    message: snippet.slice(0, 80),
    link
  });

const commentReply = (parentAuthorId, replierName, snippet, link) =>
  push(parentAuthorId, {
    type: 'SOCIAL',
    title: `${replierName} respondeu ao teu comentário`,
    message: snippet.slice(0, 80),
    link
  });

const commentLiked = (authorId, likerName, snippet, link) =>
  push(authorId, {
    type: 'SOCIAL',
    title: `${likerName} gostou do teu comentário`,
    message: snippet.slice(0, 80),
    link
  });

const mentioned = (userId, authorName, link) =>
  push(userId, {
    type: 'SOCIAL',
    title: `${authorName} mencionou-te`,
    message: `${authorName} mencionou-te numa publicação.`,
    link
  });

module.exports = {
  init, push, warmPrefs, invalidatePrefs, shouldEmail, orderReceived, orderStatusChanged,
  newMessage, feeAlert, accountSuspended, accountVerified, broadcastToRole,
  newProductFromFollowed, backInStock, newFollower, commentOnContent, commentReply, commentLiked,
  mentioned
};
