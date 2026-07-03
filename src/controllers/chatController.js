'use strict';

const { ok, created, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

// Usa o singleton partilhado — instanciar 'new PrismaClient()' aqui abria
// um pool de ligações à parte, nunca partilhado com o resto da app, o que
// esgotava as ligações disponíveis no Postgres sob carga (este ficheiro
// recebe polling a cada 4s do chat.html, por isso era o pior ofensor).
const prisma = require('../config/database');

const getOrCreateChat = async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) return badRequest(res, 'Não pode conversar consigo mesmo.');

    const otherUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!otherUser) return notFound(res, 'Utilizador não encontrado.');

    const [userAId, userBId] = [req.user.id, userId].sort();

    let chat = await prisma.chat.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      include: {
        userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
        userB: { select: { id: true, name: true, avatarUrl: true, role: true } }
      }
    });

    if (!chat) {
      try {
        chat = await prisma.chat.create({
          data: { userAId, userBId },
          include: {
            userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
            userB: { select: { id: true, name: true, avatarUrl: true, role: true } }
          }
        });
      } catch (createErr) {
        // P2002: um pedido concorrente (ex: ambos os utilizadores abriram
        // o chat quase ao mesmo tempo) já criou a mesma conversa — vai
        // simplesmente buscar a que venceu a corrida.
        if (createErr.code !== 'P2002') throw createErr;
        chat = await prisma.chat.findUnique({
          where: { userAId_userBId: { userAId, userBId } },
          include: {
            userA: { select: { id: true, name: true, avatarUrl: true, role: true } },
            userB: { select: { id: true, name: true, avatarUrl: true, role: true } }
          }
        });
      }
    }

    return ok(res, { chat });
  } catch (err) {
    logger.error(`[Chat.getOrCreateChat] ${err.message}`);
    return serverError(res);
  }
};

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

    const formatted = chats.map(c => ({
      id: c.id,
      userAId: c.userAId,
      userBId: c.userBId,
      userA: c.userA,
      userB: c.userB,
      lastMessage: c.messages[0] || null,
      unreadCount: c._count.messages,
      updatedAt: c.updatedAt
    }));

    return ok(res, { chats: formatted });
  } catch (err) {
    logger.error(`[Chat.myChats] ${err.message}`);
    return serverError(res);
  }
};

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
