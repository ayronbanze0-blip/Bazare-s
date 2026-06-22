'use strict';

const logger = require('../utils/logger');

let prismaClient;
let ioClient;

const init = (prisma, io) => {
  prismaClient = prisma;
  ioClient = io;
};

/**
 * Create a notification and emit via Socket.IO
 */
const push = async (userId, { type = 'INFO', title, message, link = null }) => {
  if (!prismaClient) { logger.warn('[Notif] Prisma not initialized'); return null; }
  try {
    const notif = await prismaClient.notification.create({
      data: { userId, type, title, message, link }
    });
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
    link: `/orders/${orderId}`
  });

const orderStatusChanged = (buyerId, orderId, status) =>
  push(buyerId, {
    type: 'ORDER',
    title: `Encomenda ${status.toLowerCase()}`,
    message: `A sua encomenda #${orderId.slice(-8)} foi ${status.toLowerCase()}.`,
    link: `/orders/${orderId}`
  });

const newMessage = (toId, fromName, preview) =>
  push(toId, {
    type: 'CHAT',
    title: `Mensagem de ${fromName}`,
    message: preview.slice(0, 80),
    link: '/chat'
  });

const feeAlert = (sellerId, amount) =>
  push(sellerId, {
    type: 'WARNING',
    title: 'Contribuição pendente',
    message: `A sua contribuição atingiu ${amount.toLocaleString('pt-MZ')} MT. Efectue o pagamento.`,
    link: '/finance'
  });

const accountSuspended = (userId, reason) =>
  push(userId, {
    type: 'ERROR',
    title: 'Conta suspensa',
    message: reason || 'A sua conta foi suspensa. Contacte o suporte.',
    link: '/support'
  });

const accountVerified = (userId) =>
  push(userId, {
    type: 'SUCCESS',
    title: 'Conta verificada!',
    message: 'A sua conta de vendedor foi verificada pela plataforma.',
    link: '/profile'
  });

const broadcastToRole = async (role, notification) => {
  if (!prismaClient) return;
  try {
    const users = await prismaClient.user.findMany({
      where: { role, active: true },
      select: { id: true }
    });
    await Promise.all(users.map(u => push(u.id, notification)));
  } catch (err) {
    logger.error(`[Notif] Broadcast failed: ${err.message}`);
  }
};

module.exports = {
  init, push, orderReceived, orderStatusChanged,
  newMessage, feeAlert, accountSuspended, accountVerified, broadcastToRole
};
