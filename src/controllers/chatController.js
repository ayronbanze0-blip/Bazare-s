'use strict';

const { ok, created, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const aiSvc = require('../services/aiService');
const uploadSvc = require('../services/uploadService');
const premiumService = require('../services/premiumService');
const logger = require('../utils/logger');

// Usa o singleton partilhado — instanciar 'new PrismaClient()' aqui abria
// um pool de ligações à parte, nunca partilhado com o resto da app, o que
// esgotava as ligações disponíveis no Postgres sob carga (este ficheiro
// recebe polling a cada 4s do chat.html, por isso era o pior ofensor).
const prisma = require('../config/database');

// ─── BazarBot ──────────────────────────────────────────────────────
// Cache simples em memória do id do utilizador-sistema BazarBot — evita
// uma query extra em cada mensagem. Se o processo reiniciar, é
// recalculado na próxima chamada.
let bazarBotUserIdCache = null;
const getBazarBotUserId = async () => {
  if (bazarBotUserIdCache) return bazarBotUserIdCache;
  const bot = await prisma.user.findFirst({ where: { isBazarBot: true }, select: { id: true } });
  if (bot) bazarBotUserIdCache = bot.id;
  return bazarBotUserIdCache;
};

// ─── GET /api/chat/bazarbot — obtém (ou cria) a conversa com o BazarBot
const getBazarBotChat = async (req, res) => {
  try {
    const botId = await getBazarBotUserId();
    if (!botId) return notFound(res, 'BazarBot ainda não está configurado. Corre a migração SQL primeiro.');

    const [userAId, userBId] = [req.user.id, botId].sort();
    let chat = await prisma.chat.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      include: {
        userA: { select: { id: true, name: true, avatarUrl: true, isBazarBot: true } },
        userB: { select: { id: true, name: true, avatarUrl: true, isBazarBot: true } }
      }
    });

    if (!chat) {
      chat = await prisma.chat.create({
        data: { userAId, userBId },
        include: {
          userA: { select: { id: true, name: true, avatarUrl: true, isBazarBot: true } },
          userB: { select: { id: true, name: true, avatarUrl: true, isBazarBot: true } }
        }
      });

      // Mensagem de boas-vindas automática, só na primeira vez
      const welcome = await prisma.message.create({
        data: {
          chatId: chat.id,
          senderId: botId,
          text: 'Olá! Sou o BazarBot 🤖 Posso ajudar com dúvidas sobre pagamentos, entregas, a tua Carteira ou como usar o Bazares. Em que posso ajudar?',
          fromBot: true
        }
      });
      chat._welcomeMessage = welcome;
    }

    return ok(res, { chat });
  } catch (err) {
    logger.error(`[Chat.getBazarBotChat] ${err.message}`);
    return serverError(res);
  }
};

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
    const hasImage = !!(req.file);

    if ((!text || !text.trim()) && !hasImage) return badRequest(res, 'Mensagem vazia.');

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return notFound(res, 'Conversa não encontrada.');
    if (chat.userAId !== req.user.id && chat.userBId !== req.user.id) return forbidden(res);

    // ─── Upload da imagem (se houver) ───────────────────────────
    let imageUrl = null, imagePublicId = null;
    if (hasImage) {
      const uploadResult = await uploadSvc.uploadToCloud(req.file.path, 'bazares/chat');
      if (!uploadResult.ok) return badRequest(res, uploadResult.error);
      imageUrl = uploadResult.url;
      imagePublicId = uploadResult.publicId;
    }

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: req.user.id,
        text: text ? sanitize(text) : '',
        imageUrl,
        imagePublicId
      },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
    });

    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });

    const recipientId = chat.userAId === req.user.id ? chat.userBId : chat.userAId;

    const io = req.app.get('io');
    if (io) {
      io.to(`chat:${chatId}`).emit('message:new', message);
      io.to(`user:${recipientId}`).emit('chat:unread', { chatId });
    }

    // ─── BazarBot: se o destinatário é o bot, gera e envia a resposta ───
    const botId = await getBazarBotUserId();
    if (botId && recipientId === botId && text && text.trim()) {
      // Não bloqueia a resposta ao utilizador — corre depois de já termos
      // devolvido a mensagem dele. Falhas aqui só ficam em log.
      (async () => {
        try {
          const recent = await prisma.message.findMany({
            where: { chatId },
            orderBy: { createdAt: 'desc' },
            take: 6,
            select: { text: true, fromBot: true, senderId: true }
          });
          const history = recent.reverse().map(m => ({ text: m.text, fromBot: m.fromBot }));

          const reply = await aiSvc.bazarBotReply(text, history);
          const botMessage = await prisma.message.create({
            data: { chatId, senderId: botId, text: reply.text, fromBot: true },
            include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
          });
          await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
          if (io) {
            io.to(`chat:${chatId}`).emit('message:new', botMessage);
            io.to(`user:${req.user.id}`).emit('chat:unread', { chatId });
          }
        } catch (err) {
          logger.error(`[Chat.bazarBotReply] ${err.message}`);
        }
      })();
    } else if (recipientId !== botId) {
      notifSvc.newMessage(recipientId, req.user.name, text || '📷 Imagem');
    }

    return created(res, { message }, 'Mensagem enviada.');
  } catch (err) {
    logger.error(`[Chat.sendMessage] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/chat/:chatId/suggest-reply ─────────────────────────
// Assistente de resposta: sugere ao vendedor uma resposta para a
// última mensagem do comprador. Não envia nada — só devolve texto
// para o vendedor rever/editar antes de enviar.
const suggestReply = async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return notFound(res, 'Conversa não encontrada.');
    if (chat.userAId !== req.user.id && chat.userBId !== req.user.id) return forbidden(res);

    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!premiumService.isActive(me)) {
      return forbidden(res, 'O assistente de atendimento com IA é exclusivo da Conta Premium.');
    }

    const recent = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { text: true, senderId: true }
    });
    if (!recent.length) return badRequest(res, 'Ainda não há mensagens nesta conversa.');

    const lastBuyerMsg = recent.find(m => m.senderId !== req.user.id);
    if (!lastBuyerMsg) return badRequest(res, 'Não há mensagem do comprador para responder.');

    const history = recent.reverse().map(m => ({ text: m.text, fromSeller: m.senderId === req.user.id }));
    const result = await aiSvc.suggestSellerReply(lastBuyerMsg.text, history);
    if (!result.ok) return badRequest(res, result.error);

    return ok(res, { suggestion: result.suggestion });
  } catch (err) {
    logger.error(`[Chat.suggestReply] ${err.message}`);
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

module.exports = { getOrCreateChat, myChats, getMessages, sendMessage, unreadCount, getBazarBotChat, suggestReply };
