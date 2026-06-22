'use strict';

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');

const prisma = new PrismaClient();

// Track online users in-memory: userId -> Set of socket ids
const onlineUsers = new Map();

const setupSocket = (io) => {
  // ─── Auth middleware for sockets ───────────────────────────────
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

    // Join personal room for direct notifications
    socket.join(`user:${userId}`);

    // Track online status
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    io.emit('presence:online', { userId });

    // ─── Join a specific chat room ─────────────────────────────
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

    // ─── Send message ────────────────────────────────────────────
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

        // Emit to everyone in the chat room (including sender for confirmation)
        io.to(`chat:${chatId}`).emit('message:new', message);

        // Notify recipient if not in the room
        const recipientId = chat.userAId === userId ? chat.userBId : chat.userAId;
        io.to(`user:${recipientId}`).emit('chat:unread', { chatId, message });

        notifSvc.newMessage(recipientId, socket.user.name, text);
      } catch (err) {
        logger.error(`[Socket message:send] ${err.message}`);
        socket.emit('error', { message: 'Falha ao enviar mensagem.' });
      }
    });

    // ─── Typing indicator ───────────────────────────────────────
    socket.on('typing:start', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:start', { userId, chatId });
    });
    socket.on('typing:stop', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing:stop', { userId, chatId });
    });

    // ─── Mark messages as read ────────────────────────────────────
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

    // ─── Check presence ────────────────────────────────────────────
    socket.on('presence:check', ({ userId: targetId }, callback) => {
      const isOnline = onlineUsers.has(targetId) && onlineUsers.get(targetId).size > 0;
      if (typeof callback === 'function') callback({ online: isOnline });
    });

    // ─── Disconnect ─────────────────────────────────────────────
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
