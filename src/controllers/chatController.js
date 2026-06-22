'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Get or create chat between two users ────────────────────────
const getOrCreateChat = async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) return badRequest(res, 'Não pode conversar consigo mesmo.');

    const otherUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!otherUser) return notFound(res, 'Utilizador não encontrado.');

    // Normalize order to avoid duplicate chats (a,b) vs (b,a)
    const [userAId, userBId] = [req.user.id, userId].sort();

    let chat = await prisma.chat.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      include: {
        userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
        userB: { select: { id: true, name: true, avatarUrl: true, role: true } }
      }
    });

    if (!chat) {
      chat = await prisma.chat.create({
        data: { userAId, userBId },
        include: {
          userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
          userB: { select: { id: true, name: true, avatarUrl: true, role: true } }
        }
      });
    }

    return ok(res, { chat });
  } catch (err) {
    logger.error(`[Chat.getOrCreateChat] ${err.message}`);
    return serverError(res);
  }
};

// ─── List my chats ────────────────────────────────────────────────
const myChats = async (req, res) => {
  try {
    const chats = await prisma.chat.findMany({
      where: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] },
      orderBy: { updatedAt: 'desc' },
      include: {
        userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
        userB: { select: { id: true, name: true, avatarUrl: true, role: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: {
          select: {
            messages: { where: { read: false, senderId: { not: req.user.id } } }
          }
        }
      }
    });

    const formatted = chats.map(c => {
      const other = c.userAId === req.user.id ? c.userB : c.userA;
      return {
        id: c.id,
        other,
        lastMessage: c.messages[0] || null,
        unreadCount: c._count.messages,
        updatedAt: c.updatedAt
      };
    });

    return ok(res, { chats: formatted });
  } catch (err) {
    logger.error(`[Chat.myChats] ${err.message}`);
    return serverError(res);
  }
};

// ─── Get messages in a chat ───────────────────────────────────────
const getMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { before, limit = 50 } = req.query;

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return notFound(res, 'Conversa não encontrada.');
    if (chat.userAId !== req.user.id && chat.userBId !== req.user.id) return forbidden(res);

    const messages = await prisma.message.findMany({
      where: {
        chatId,
        ...(before && { createdAt: { lt: new Date(before) } })
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
    });

    // Mark messages as read
    await prisma.message.updateMany({
      where: { chatId, senderId: { not: req.user.id }, read: false },
      data: { read: true, readAt: new Date() }
    });

    return ok(res, { messages: messages.reverse() });
  } catch (err) {
    logger.error(`[Chat.getMessages] ${err.message}`);
    return serverError(res);
  }
};

// ─── Send message (REST fallback; Socket.IO is primary path) ────
const sendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) return badRequest(res, 'Mensagem vazia.');

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return notFound(res, 'Conversa não encontrada.');
    if (chat.userAId !== req.user.id && chat.userBId !== req.user.id) return forbidden(res);

    const message = await prisma.message.create({
      data: { chatId, senderId: req.user.id, text: sanitize(text) },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
    });

    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });

    const recipientId = chat.userAId === req.user.id ? chat.userBId : chat.userAId;
    notifSvc.newMessage(recipientId, req.user.name, text);

    // Emit via Socket.IO if available (attached to app)
    const io = req.app.get('io');
    if (io) {
      io.to(`chat:${chatId}`).emit('message:new', message);
      io.to(`user:${recipientId}`).emit('chat:unread', { chatId });
    }

    return created(res, { message }, 'Mensagem enviada.');
  } catch (err) {
    logger.error(`[Chat.sendMessage] ${err.message}`);
    return serverError(res);
  }
};

// ─── Get total unread count ───────────────────────────────────────
const unreadCount = async (req, res) => {
  try {
    const count = await prisma.message.count({
      where: {
        read: false,
        senderId: { not: req.user.id },
        chat: { OR: [{ userAId: req.user.id }, { userBId: req.user.id }] }
      }
    });
    return ok(res, { count });
  } catch (err) {
    logger.error(`[Chat.unreadCount] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { getOrCreateChat, myChats, getMessages, sendMessage, unreadCount };
