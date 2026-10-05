'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const aiSvc = require('../services/aiService');
const blockSvc = require('../services/blockService');

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

const MAX_MESSAGE_LENGTH = 4000;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

// Limitador simples por socket+evento (janela fixa). Impede que UMA ligação autenticada
// inunde a BD/sala com eventos (mensagens, typing, joins...).
const makeLimiter = (max, windowMs) => {
  let count = 0;
  let start = Date.now();
  return () => {
    const now = Date.now();
    if (now - start >= windowMs) { start = now; count = 0; }
    return ++count <= max;
  };
};

// Envolve um handler de evento: (1) o payload é SEMPRE um objecto — um cliente que emita
// o evento sem argumentos (ou com lixo) fazia `({ chatId }) =>` rebentar de forma síncrona,
// o que o Node trata como uncaughtException e o server.js responde com process.exit(1):
// qualquer utilizador autenticado conseguia derrubar o servidor com uma linha;
// (2) erros síncronos e rejeições assíncronas ficam contidos; (3) limite por ligação.
const guard = (socket, event, handler, { max = 30, windowMs = 10000 } = {}) => {
  const allow = makeLimiter(max, windowMs);
  return (payload, ...rest) => {
    try {
      if (!allow()) return;
      const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const out = handler(data, ...rest);
      if (out && typeof out.catch === 'function') {
        out.catch((err) => logger.error(`[Socket ${event}] ${err.message}`));
      }
    } catch (err) {
      logger.error(`[Socket ${event}] ${err.message}`);
    }
  };
};

const setupSocket = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Token não fornecido'));
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });

      // Mesma verificação que o middleware `authenticate` do REST faz:
      // o token pode continuar válido mesmo depois de a conta ter sido
      // suspensa ou apagada (JWT não é revogável por si só). Sem isto,
      // uma conta suspensa continuava a receber/enviar eventos em tempo
      // real até o token expirar (~15 min).
      const dbUser = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { active: true, role: true }
      });
      if (!dbUser || !dbUser.active) return next(new Error('Conta suspensa ou inexistente'));

      socket.user = { ...decoded, role: dbUser.role };
      next();
    } catch (err) {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[Socket] Connected: ${socket.user.name} (${userId})`);

    socket.join(`user:${userId}`);

    const on = (event, handler, opts) => socket.on(event, guard(socket, event, handler, opts));

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    io.emit('presence:online', { userId });

    on('chat:join', async ({ chatId }) => {
      try {
        if (!isId(chatId)) return;
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

    on('chat:leave', ({ chatId }) => {
      socket.leave(`chat:${chatId}`);
    });

    on('message:send', async ({ chatId, text, clientMessageId }) => {
      try {
        if (!isId(chatId) || typeof text !== 'string' || !text.trim()) return;
        if (text.length > MAX_MESSAGE_LENGTH) {
          return socket.emit('error', { message: `Mensagem demasiado longa (máx. ${MAX_MESSAGE_LENGTH} caracteres).` });
        }
        if (clientMessageId !== undefined && clientMessageId !== null && (typeof clientMessageId !== 'string' || clientMessageId.length > 100)) return;
        const chat = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chat || (chat.userAId !== userId && chat.userBId !== userId)) {
          return socket.emit('error', { message: 'Acesso negado.' });
        }

        // Mesma regra aplicada no envio via REST (chatController.sendMessage):
        // se um dos dois bloqueou o outro depois do chat ter começado, a
        // mensagem não deve ser gravada — só esconder o chat na lista não
        // impede o socket de continuar entregando mensagens novas.
        const otherPartyId = chat.userAId === userId ? chat.userBId : chat.userAId;
        if (await blockSvc.isBlockedEither(userId, otherPartyId)) {
          return socket.emit('error', { message: 'Não é possível enviar mensagens nesta conversa.' });
        }

        // Idempotência: mesmo mecanismo do REST — um reenvio (reconexão do
        // socket a meio do envio, app em background que reenvia ao voltar)
        // com o mesmo clientMessageId devolve a mensagem já criada em vez
        // de duplicá-la.
        if (clientMessageId) {
          const existing = await prisma.message.findUnique({
            where: { clientMessageId },
            include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
          });
          if (existing && existing.chatId === chatId) {
            return socket.emit('message:new', existing);
          }
        }

        let message;
        try {
          message = await prisma.message.create({
            data: { chatId, senderId: userId, text: sanitize(text), clientMessageId: clientMessageId || null },
            include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
          });
        } catch (createErr) {
          if (createErr.code === 'P2002' && clientMessageId) {
            const winner = await prisma.message.findUnique({
              where: { clientMessageId },
              include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
            });
            if (winner) return socket.emit('message:new', winner);
          }
          throw createErr;
        }

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
          notifSvc.newMessage(recipientId, socket.user.name, text, chatId);
        }
      } catch (err) {
        logger.error(`[Socket message:send] ${err.message}`);
        socket.emit('error', { message: 'Falha ao enviar mensagem.' });
      }
    }, { max: 20, windowMs: 10000 });

    // Só quem já fez chat:join (e portanto foi validado como participante) pode emitir
    // eventos para a sala — antes qualquer utilizador autenticado podia injectar "a escrever…"
    // em conversas alheias só com o chatId.
    on('typing:start', ({ chatId }) => {
      if (!isId(chatId) || !socket.rooms.has(`chat:${chatId}`)) return;
      socket.to(`chat:${chatId}`).emit('typing:start', { userId, chatId });
    });
    on('typing:stop', ({ chatId }) => {
      if (!isId(chatId) || !socket.rooms.has(`chat:${chatId}`)) return;
      socket.to(`chat:${chatId}`).emit('typing:stop', { userId, chatId });
    });

    on('messages:read', async ({ chatId }) => {
      try {
        if (!isId(chatId)) return;
        // Antes: marcava como lidas as mensagens de QUALQUER chat só com o chatId (sem
        // confirmar que o utilizador participa) e avisava a sala.
        const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { userAId: true, userBId: true } });
        if (!chat || (chat.userAId !== userId && chat.userBId !== userId)) return;
        await prisma.message.updateMany({
          where: { chatId, senderId: { not: userId }, read: false },
          data: { read: true, readAt: new Date() }
        });
        io.to(`chat:${chatId}`).emit('messages:read', { chatId, readBy: userId });
      } catch (err) {
        logger.error(`[Socket messages:read] ${err.message}`);
      }
    });

    on('presence:check', ({ userId: targetId }, callback) => {
      if (!isId(targetId)) return;
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

// ─── Desconecta imediatamente todos os sockets de um utilizador ───────
// Chamado pelo admin ao suspender uma conta (adminController.toggleUser):
// sem isto, uma sessão de socket já aberta continuava viva e a receber/
// enviar eventos em tempo real até o token expirar, mesmo com a conta
// já suspensa (o handshake só é verificado uma vez, na ligação).
const forceDisconnectUser = (io, userId) => {
  io.in(`user:${userId}`).disconnectSockets(true);
};

module.exports = { setupSocket, isOnline, forceDisconnectUser };

