'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const aiSvc = require('../services/aiService');

// Singleton partilhado — ver nota em controllers/chatController.js
const prisma = require('../config/database');

const onlineUsers = new Map();

// Cache do id do BazarBot — mesma lógica que em chatController.js. Os dois
// processos (HTTP e socket) correm no mesmo servidor Node, mas mantemos o
// cache separado para não acoplar os dois ficheiros um ao outro.
let bazarBotUserIdCache = null;
const getBazarBotUserId = async (prisma) => {
  if (bazarBotUserIdCache) return bazarBotUserIdCache;
  const bot = await prisma.user.findFirst({ where: { isBazarBot: true }, select: { id: true } });
  if (bot) bazarBotUserIdCache = bot.id;
  return bazarBotUserIdCache;
};

const setupSocket = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Token não fornecido'));
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[Socket] Connected: ${socket.user.name} (${userId})`);

    socket.join(`user:${userId}`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    io.emit('presence:online', { userId });

    socket.on('chat:join', async ({ chatId }) => {
      try {
        const chat = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chat || (chat.userAId !== userId && chat.userBId !== userId)) {
          return socket.emit('error', { message: 'Acesso negado a esta conversa.' });
        }
        socket.join(`chat:${chatId}`);
        socket.emit('chat:joined', { chatId });
      } catch (err) {
        logger.error(`[Socket chat:join] ${err.message}`);
      }
    });

    socket.on('chat:leave', ({ chatId }) => {
      socket.leave(`chat:${chatId}`);
    });

    socket.on('message:send', async ({ chatId, text }) => {
      try {
        if (!text || !text.trim()) return;
        const chat = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chat || (chat.userAId !== userId && chat.userBId !== userId)) {
          return socket.emit('error', { message: 'Acesso negado.' });
        }

        const message = await prisma.message.create({
          data: { chatId, senderId: userId, text: sanitize(text) },
          include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
        });

        await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });

        io.to(`chat:${chatId}`).emit('message:new', message);

        const recipientId = chat.userAId === userId ? chat.userBId : chat.userAId;
        io.to(`user:${recipientId}`).emit('chat:unread', { chatId, message });

        const botId = await getBazarBotUserId(prisma);
        if (botId && recipientId === botId) {
          // BazarBot responde por este mesmo canal — não bloqueia o emit acima.
          (async () => {
            try {
              const recent = await prisma.message.findMany({
                where: { chatId },
                orderBy: { createdAt: 'desc' },
                take: 6,
                select: { text: true, fromBot: true }
              });
              const history = recent.reverse().map(m => ({ text: m.text, fromBot: m.fromBot }));
              const reply = await aiSvc.bazarBotReply(text, history);
              const botMessage = await prisma.message.create({
                data: { chatId, senderId: botId, text: reply.text, fromBot: true },
                include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
              });
              await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
              io.to(`chat:${chatId}`).emit('message:new', botMessage);
              io.to(`user:${userId}`).emit('chat:unread', { chatId });
            } catch (err) {
              logger.error(`[Socket bazarBotReply] ${err.message}`);
            }
          })();
        } else {
          notifSvc.newMessage(recipientId, socket.user.name, text);
        }
      } catch (err) {
        logger.error(`[Socket message:send] ${err.message}`);
        socket.emit('error', { message: 'Falha ao enviar mensagem.' });
      }
    });

    socket.on('typing:start', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:start', { userId, chatId });
    });
    socket.on('typing:stop', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:stop', { userId, chatId });
    });

    socket.on('messages:read', async ({ chatId }) => {
      try {
        await prisma.message.updateMany({
          where: { chatId, senderId: { not: userId }, read: false },
          data: { read: true, readAt: new Date() }
        });
        io.to(`chat:${chatId}`).emit('messages:read', { chatId, readBy: userId });
      } catch (err) {
        logger.error(`[Socket messages:read] ${err.message}`);
      }
    });

    socket.on('presence:check', ({ userId: targetId }, callback) => {
      const isOnline = onlineUsers.has(targetId) && onlineUsers.get(targetId).size > 0;
      if (typeof callback === 'function') callback({ online: isOnline });
    });

    socket.on('disconnect', () => {
      logger.info(`[Socket] Disconnected: ${socket.user.name} (${userId})`);
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          io.emit('presence:offline', { userId });
        }
      }
    });
  });
};

const isOnline = (userId) => onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;

module.exports = { setupSocket, isOnline };

