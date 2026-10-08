'use strict';

/** Suporte: tickets do utilizador + fila do admin. */
const prisma = require('../config/database');
const { ok, created } = require('../utils/response');
const { handle, bad, notFoundErr, forbiddenErr, conflictErr } = require('../utils/appError');
const V = require('../utils/validate');
const notifSvc = require('../services/notificationService');
const { paginate, paginateMeta } = require('../utils/helpers');

const CATEGORIES = ['ORDER', 'PAYMENT', 'ACCOUNT', 'PRODUCT', 'TECHNICAL', 'OTHER'];
const STATUSES = ['OPEN', 'PENDING_USER', 'RESOLVED', 'CLOSED'];
const MAX_OPEN_TICKETS = 5;
const MAX_MESSAGES_PER_TICKET = 200;
const short = (id) => String(id).slice(-6).toUpperCase();

const authorSelect = { id: true, name: true, avatarUrl: true, role: true };
const messageInclude = { orderBy: { createdAt: 'asc' }, include: { author: { select: authorSelect } } };

const create = handle('Support.create', async (req, res) => {
  V.bodyObject(req.body);
  const subject = V.text(req.body.subject, 'subject', { min: 4, max: 120 });
  const category = V.oneOf(req.body.category, 'category', CATEGORIES, { def: 'OTHER' });
  const message = V.text(req.body.message, 'message', { min: 5, max: 2000, multiline: true });
  const attachments = V.urls(req.body.attachments, 'attachments', { max: 4 });
  let orderId = null;
  if (req.body.orderId) {
    orderId = V.id(req.body.orderId, 'orderId');
    const o = await prisma.order.findFirst({ where: { id: orderId, OR: [{ buyerId: req.user.id }, { sellerId: req.user.id }] }, select: { id: true } });
    if (!o) throw notFoundErr('Encomenda não encontrada.');
  }
  const open = await prisma.supportTicket.count({ where: { userId: req.user.id, status: { in: ['OPEN', 'PENDING_USER'] } } });
  if (open >= MAX_OPEN_TICKETS) throw bad(`Já tens ${open} pedidos de suporte em aberto. Aguarda resposta ou fecha algum.`, 'TICKET_LIMIT');

  const ticket = await prisma.supportTicket.create({
    data: { userId: req.user.id, subject, category, orderId, messages: { create: { authorId: req.user.id, body: message, attachments } } },
    include: { messages: messageInclude }
  });
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true }, take: 20 });
  admins.forEach((a) => notifSvc.push(a.id, { type: 'INFO', category: 'system', title: 'Novo pedido de suporte', message: `#${short(ticket.id)} — ${subject}`.slice(0, 120), link: '/admin/support' }));
  return created(res, { ticket }, 'Pedido enviado. Respondemos o mais depressa possível.');
});

const mine = handle('Support.mine', async (req, res) => {
  const { skip, take } = paginate(req.query.page, req.query.limit);
  const status = req.query.status ? V.oneOf(req.query.status, 'status', STATUSES) : undefined;
  const where = { userId: req.user.id, ...(status && { status }) };
  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip, take, include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, isStaff: true, createdAt: true } } } }),
    prisma.supportTicket.count({ where })
  ]);
  return ok(res, { tickets, meta: paginateMeta(total, req.query.page, req.query.limit) });
});

const loadTicket = async (user, id, { staff = false } = {}) => {
  const t = await prisma.supportTicket.findUnique({ where: { id }, include: { messages: messageInclude, user: { select: authorSelect } } });
  if (!t) throw notFoundErr('Pedido não encontrado.');
  if (!staff && t.userId !== user.id) throw forbiddenErr();
  return t;
};

const getOne = handle('Support.get', async (req, res) => ok(res, { ticket: await loadTicket(req.user, V.id(req.params.id)) }));

const postMessage = (staff) => handle(staff ? 'Support.adminReply' : 'Support.reply', async (req, res) => {
  V.bodyObject(req.body);
  const body = V.text(req.body.message, 'message', { min: 1, max: 2000, multiline: true });
  const attachments = V.urls(req.body.attachments, 'attachments', { max: 4 });
  const ticket = await loadTicket(req.user, V.id(req.params.id), { staff });
  if (ticket.status === 'CLOSED') throw conflictErr('Este pedido está fechado. Abre um novo.', 'TICKET_CLOSED');
  if (ticket.messages.length >= MAX_MESSAGES_PER_TICKET) throw bad('Este pedido atingiu o limite de mensagens. Abre um novo.', 'TICKET_FULL');

  // Resposta do utilizador reabre um pedido RESOLVIDO; resposta do suporte fica a aguardar o utilizador
  const nextStatus = staff ? 'PENDING_USER' : 'OPEN';
  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({ data: { ticketId: ticket.id, authorId: req.user.id, isStaff: staff, body, attachments }, include: { author: { select: authorSelect } } }),
    prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: nextStatus, lastMessageAt: new Date() } })
  ]);
  if (staff) notifSvc.push(ticket.userId, { type: 'INFO', category: 'system', title: 'Resposta do suporte', message: body.slice(0, 120), link: `/support/${ticket.id}` });
  return created(res, { message, status: nextStatus });
});

const close = handle('Support.close', async (req, res) => {
  const r = await prisma.supportTicket.updateMany({ where: { id: V.id(req.params.id), userId: req.user.id, status: { not: 'CLOSED' } }, data: { status: 'CLOSED' } });
  if (!r.count) throw notFoundErr('Pedido não encontrado ou já fechado.');
  return ok(res, { closed: true }, 'Pedido fechado.');
});

// ─── Admin ────────────────────────────────────────────────────────
const adminList = handle('Support.adminList', async (req, res) => {
  const { skip, take } = paginate(req.query.page, req.query.limit);
  const status = req.query.status ? V.oneOf(req.query.status, 'status', STATUSES) : undefined;
  const where = { ...(status ? { status } : { status: { in: ['OPEN', 'PENDING_USER'] } }), ...(req.query.category && { category: V.oneOf(req.query.category, 'category', CATEGORIES) }) };
  const [tickets, total, counts] = await Promise.all([
    prisma.supportTicket.findMany({ where, orderBy: { lastMessageAt: 'asc' }, skip, take, include: { user: { select: authorSelect }, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, isStaff: true, createdAt: true } } } }),
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } })
  ]);
  return ok(res, { tickets, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), meta: paginateMeta(total, req.query.page, req.query.limit) });
});
const adminGet = handle('Support.adminGet', async (req, res) => ok(res, { ticket: await loadTicket(req.user, V.id(req.params.id), { staff: true }) }));
const adminSetStatus = handle('Support.adminStatus', async (req, res) => {
  V.bodyObject(req.body);
  const status = V.oneOf(req.body.status, 'status', STATUSES);
  const t = await prisma.supportTicket.findUnique({ where: { id: V.id(req.params.id) } });
  if (!t) throw notFoundErr('Pedido não encontrado.');
  await prisma.supportTicket.update({ where: { id: t.id }, data: { status } });
  if (status === 'RESOLVED') notifSvc.push(t.userId, { type: 'SUCCESS', category: 'system', title: 'Pedido de suporte resolvido', message: t.subject.slice(0, 120), link: `/support/${t.id}` });
  return ok(res, { status }, 'Estado actualizado.');
});

module.exports = { create, mine, getOne, reply: postMessage(false), adminReply: postMessage(true), close, adminList, adminGet, adminSetStatus };
