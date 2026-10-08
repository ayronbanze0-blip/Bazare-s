'use strict';

/** Conta: sessões activas, exportação de dados e verificação de versão da app. */
const prisma = require('../config/database');
const { ok } = require('../utils/response');
const { handle, notFoundErr } = require('../utils/appError');
const V = require('../utils/validate');
const appVersion = require('../services/appVersion');

const maskIp = (ip) => {
  if (!ip) return null;
  if (ip.includes('.')) { const p = ip.replace(/^::ffff:/, '').split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : null; }
  const p = ip.split(':'); return p.length > 2 ? `${p[0]}:${p[1]}:*:*` : null;
};

/** "Chrome em Android", "Safari em iPhone"… — só para o utilizador reconhecer o dispositivo. */
const describeAgent = (ua = '') => {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /okhttp|Capacitor|wv\)/i.test(ua) ? 'App Bazares' : 'Navegador';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'dispositivo desconhecido';
  return `${browser} em ${os}`;
};

const sessions = handle('Account.sessions', async (req, res) => {
  const current = (req.cookies && req.cookies.refreshToken) || (req.body && req.body.refreshToken) || null;
  const rows = await prisma.refreshToken.findMany({
    where: { userId: req.user.id, revoked: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }, take: 30,
    select: { id: true, token: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true }
  });
  return ok(res, {
    sessions: rows.map((r) => ({ id: r.id, device: describeAgent(r.userAgent || ''), ip: maskIp(r.ipAddress), createdAt: r.createdAt, expiresAt: r.expiresAt, current: Boolean(current && r.token === current) }))
  });
});

const revokeSession = handle('Account.revokeSession', async (req, res) => {
  const r = await prisma.refreshToken.updateMany({ where: { id: V.id(req.params.id), userId: req.user.id, revoked: false }, data: { revoked: true, revokedAt: new Date() } });
  if (!r.count) throw notFoundErr('Sessão não encontrada.');
  return ok(res, { revoked: true }, 'Sessão terminada.');
});

/** Exportação dos dados pessoais (portabilidade). Não inclui hashes, tokens nem dados de terceiros. */
const exportData = handle('Account.export', async (req, res) => {
  const uid = req.user.id;
  const [user, addresses, orders, favorites, reviews, tickets, wallet, plans] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid }, select: { id: true, name: true, email: true, username: true, phone: true, location: true, bio: true, role: true, createdAt: true, verified: true, isPremium: true, premiumExpiresAt: true } }),
    prisma.address.findMany({ where: { userId: uid } }),
    prisma.order.findMany({ where: { OR: [{ buyerId: uid }, { sellerId: uid }] }, orderBy: { createdAt: 'desc' }, take: 1000, include: { items: { select: { name: true, qty: true, price: true } } } }),
    prisma.favorite.findMany({ where: { userId: uid }, select: { productId: true, createdAt: true }, take: 1000 }),
    prisma.review.findMany({ where: { buyerId: uid }, select: { productId: true, rating: true, comment: true, createdAt: true }, take: 1000 }),
    prisma.supportTicket.findMany({ where: { userId: uid }, include: { messages: { select: { body: true, isStaff: true, createdAt: true } } }, take: 200 }),
    prisma.wallet.findUnique({ where: { userId: uid }, select: { balance: true, transactions: { orderBy: { createdAt: 'desc' }, take: 1000, select: { type: true, amount: true, balanceAfter: true, status: true, description: true, createdAt: true } } } }),
    prisma.installmentPlan.findMany({ where: { OR: [{ buyerId: uid }, { sellerId: uid }] }, include: { installments: true }, take: 500 })
  ]);
  res.set('Content-Disposition', `attachment; filename="bazares-os-meus-dados-${new Date().toISOString().slice(0, 10)}.json"`);
  res.set('Cache-Control', 'no-store');
  return ok(res, { exportedAt: new Date().toISOString(), user, addresses, orders, favorites, reviews, supportTickets: tickets, wallet, installmentPlans: plans });
});

/** GET /api/app/version?platform=android&version=1.2.0 — público. */
const version = (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, appVersion.check({ platform: req.query.platform, version: req.query.version }));
};

module.exports = { sessions, revokeSession, exportData, version, maskIp, describeAgent };
