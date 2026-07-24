'use strict';


const { ok, notFound, forbidden, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const logger = require('../utils/logger');

const prisma = require('../config/database');

// ─── List my notifications ────────────────────────────────────────
const list = async (req, res) => {
  try {
    const { page = 1, limit = 30, unreadOnly } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      userId: req.user.id,
      ...(unreadOnly === 'true' && { read: false })
    };

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.user.id, read: false } })
    ]);

    return ok(res, { notifications, unreadCount, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Notifications.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── Mark one as read ──────────────────────────────────────────────
const markRead = async (req, res) => {
  try {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif) return notFound(res);
    if (notif.userId !== req.user.id) return forbidden(res);

    await prisma.notification.update({
      where: { id: notif.id },
      data: { read: true, readAt: new Date() }
    });

    return ok(res, {}, 'Notificação marcada como lida.');
  } catch (err) {
    logger.error(`[Notifications.markRead] ${err.message}`);
    return serverError(res);
  }
};

// ─── Mark all as read ───────────────────────────────────────────────
const markAllRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true, readAt: new Date() }
    });
    return ok(res, {}, 'Todas as notificações marcadas como lidas.');
  } catch (err) {
    logger.error(`[Notifications.markAllRead] ${err.message}`);
    return serverError(res);
  }
};

// ─── Delete notification ────────────────────────────────────────────
const remove = async (req, res) => {
  try {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif) return notFound(res);
    if (notif.userId !== req.user.id) return forbidden(res);
    await prisma.notification.delete({ where: { id: notif.id } });
    return ok(res, {}, 'Notificação eliminada.');
  } catch (err) {
    logger.error(`[Notifications.remove] ${err.message}`);
    return serverError(res);
  }
};

// ─── Registar/actualizar o token FCM deste dispositivo ──────────────
// Chamado sempre que o token muda (a Firebase pode rodá-lo a qualquer
// momento) — por isso é um upsert, não um create simples. O mesmo
// token nunca pode ficar preso a um utilizador antigo (ex.: logout +
// login com outra conta no mesmo telemóvel), daí o upsert reatribuir
// userId/lastSeenAt mesmo quando o token já existia.
const registerDevice = async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return badRequest(res, 'Token do dispositivo em falta.');

    await prisma.deviceToken.upsert({
      where: { token },
      update: { userId: req.user.id, platform: platform || null, lastSeenAt: new Date() },
      create: { userId: req.user.id, token, platform: platform || null }
    });

    return ok(res, {}, 'Dispositivo registado para notificações push.');
  } catch (err) {
    logger.error(`[Notifications.registerDevice] ${err.message}`);
    return serverError(res);
  }
};

// ─── Remover o token deste dispositivo (logout, ou desactivar push) ─
const unregisterDevice = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return badRequest(res, 'Token do dispositivo em falta.');
    await prisma.deviceToken.deleteMany({ where: { token, userId: req.user.id } });
    return ok(res, {}, 'Dispositivo removido das notificações push.');
  } catch (err) {
    logger.error(`[Notifications.unregisterDevice] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, markRead, markAllRead, remove, registerDevice, unregisterDevice };
