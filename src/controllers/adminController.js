'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, badRequest, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Platform overview ────────────────────────────────────────────
const overview = async (req, res) => {
  try {
    const [
      sellersCount, buyersCount, revendedoresCount, bazarsCount, productsCount,
      ordersCount, totalSalesAgg, feesAgg, pendingReports, ordersByStatus
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'SELLER' } }),
      prisma.user.count({ where: { role: 'BUYER' } }),
      prisma.user.count({ where: { role: 'REVENDEDOR' } }),
      prisma.bazar.count(),
      prisma.product.count(),
      prisma.order.count(),
      prisma.order.aggregate({ where: { status: 'ENTREGUE' }, _sum: { total: true } }),
      prisma.transaction.aggregate({ where: { fee: { gt: 0 } }, _sum: { fee: true } }),
      prisma.report.count({ where: { status: 'PENDENTE' } }),
      prisma.order.groupBy({ by: ['status'], _count: true })
    ]);

    return ok(res, {
      sellers: sellersCount,
      buyers: buyersCount,
      revendedores: revendedoresCount,
      revendedoresMax: 20,
      bazars: bazarsCount,
      products: productsCount,
      orders: ordersCount,
      totalSalesVolume: totalSalesAgg._sum.total || 0,
      totalFeesGenerated: feesAgg._sum.fee || 0,
      pendingReports,
      ordersByStatus
    });
  } catch (err) {
    logger.error(`[Admin.overview] ${err.message}`);
    return serverError(res);
  }
};

// ─── List users with filters ─────────────────────────────────────
const listUsers = async (req, res) => {
  try {
    const { role, q, active, page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      ...(role && { role: role.toUpperCase() }),
      ...(active !== undefined && { active: active === 'true' }),
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } }
        ]
      })
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, email: true, role: true, active: true, verified: true,
          verifiedSeller: true, rating: true, ratingCount: true, cancelCount: true,
          createdAt: true, lastLoginAt: true,
          bazar: { select: { id: true, name: true, totalSales: true, pendingFees: true } },
          revendedor: { select: { id: true, name: true } },
          _count: { select: { orders: true, sellerOrders: true } }
        }
      }),
      prisma.user.count({ where })
    ]);

    return ok(res, { users, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Admin.listUsers] ${err.message}`);
    return serverError(res);
  }
};

// ─── Toggle user active/suspended ─────────────────────────────────
const toggleUser = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return notFound(res);
    if (user.role === 'ADMIN') return badRequest(res, 'Não é possível suspender um administrador.');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { active: !user.active }
    });

    // If suspending seller, deactivate bazar too
    if (!updated.active) {
      await prisma.bazar.updateMany({ where: { sellerId: user.id }, data: { active: false } });
      // Revoke sessions
      await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } });
      notifSvc.accountSuspended(user.id, reason);
      emailSvc.sendAccountSuspendedEmail(user.email, user.name, reason).catch(() => {});
    } else {
      await prisma.bazar.updateMany({ where: { sellerId: user.id }, data: { active: true } });
      notifSvc.push(user.id, { type: 'SUCCESS', title: 'Conta reactivada', message: 'A sua conta foi reactivada pelo administrador.' });
    }

    logger.info(`[Admin] User ${updated.active ? 'reactivated' : 'suspended'}: ${user.email} by ${req.user.email}`);
    return ok(res, { user: updated }, `Utilizador ${updated.active ? 'reactivado' : 'suspenso'}.`);
  } catch (err) {
    logger.error(`[Admin.toggleUser] ${err.message}`);
    return serverError(res);
  }
};

// ─── Verify seller badge ──────────────────────────────────────────
const verifySeller = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return notFound(res);
    if (user.role !== 'SELLER') return badRequest(res, 'Apenas vendedores podem ser verificados.');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { verifiedSeller: !user.verifiedSeller }
    });

    if (updated.verifiedSeller) notifSvc.accountVerified(user.id);

    return ok(res, { user: updated }, `Vendedor ${updated.verifiedSeller ? 'verificado' : 'desverificado'}.`);
  } catch (err) {
    logger.error(`[Admin.verifySeller] ${err.message}`);
    return serverError(res);
  }
};

// ─── Send message to user ──────────────────────────────────────────
const messageUser = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return badRequest(res, 'Mensagem obrigatória.');
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return notFound(res);

    notifSvc.push(user.id, { type: 'INFO', title: 'Mensagem do Administrador', message });
    return ok(res, {}, 'Mensagem enviada.');
  } catch (err) {
    logger.error(`[Admin.messageUser] ${err.message}`);
    return serverError(res);
  }
};

// ─── Broadcast to role ──────────────────────────────────────────────
const broadcast = async (req, res) => {
  try {
    const { role, message, type = 'INFO' } = req.body;
    if (!message) return badRequest(res, 'Mensagem obrigatória.');

    const where = role && role !== 'all' ? { role: role.toUpperCase(), active: true } : { active: true };
    const users = await prisma.user.findMany({ where, select: { id: true } });

    await Promise.all(users.map(u => notifSvc.push(u.id, { type, title: 'Aviso da plataforma', message })));

    logger.info(`[Admin] Broadcast sent to ${users.length} users by ${req.user.email}`);
    return ok(res, { recipientCount: users.length }, `Aviso enviado a ${users.length} utilizadores.`);
  } catch (err) {
    logger.error(`[Admin.broadcast] ${err.message}`);
    return serverError(res);
  }
};

// ─── List/manage products ────────────────────────────────────────
const listProducts = async (req, res) => {
  try {
    const { page = 1, limit = 30, active } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = active !== undefined ? { active: active === 'true' } : {};
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { images: { take: 1 }, bazar: { select: { name: true } } }
      }),
      prisma.product.count({ where })
    ]);
    return ok(res, { products, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Admin.listProducts] ${err.message}`);
    return serverError(res);
  }
};

const toggleProduct = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res);
    const updated = await prisma.product.update({ where: { id: product.id }, data: { active: !product.active } });
    notifSvc.push(product.sellerId, {
      type: 'WARNING', title: `Produto ${updated.active ? 'restaurado' : 'removido'}`,
      message: `O produto "${product.name}" foi ${updated.active ? 'restaurado' : 'removido'} pelo administrador.`
    });
    return ok(res, { active: updated.active });
  } catch (err) {
    logger.error(`[Admin.toggleProduct] ${err.message}`);
    return serverError(res);
  }
};

// ─── List all orders ──────────────────────────────────────────────
const listOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          items: { take: 1 },
          buyer: { select: { name: true } },
          seller: { select: { name: true } }
        }
      }),
      prisma.order.count({ where })
    ]);
    return ok(res, { orders, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Admin.listOrders] ${err.message}`);
    return serverError(res);
  }
};

// ─── Reports management ──────────────────────────────────────────
const listReports = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          reporter: { select: { name: true, email: true } },
          targetUser: { select: { name: true, email: true } },
          targetProduct: { select: { name: true } }
        }
      }),
      prisma.report.count({ where })
    ]);
    return ok(res, { reports, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Admin.listReports] ${err.message}`);
    return serverError(res);
  }
};

const resolveReport = async (req, res) => {
  try {
    const { status, resolution } = req.body;
    if (!['RESOLVIDA', 'ARQUIVADA', 'EM_ANALISE'].includes(status)) return badRequest(res, 'Estado inválido.');

    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: { status, resolution, resolvedAt: new Date(), resolvedBy: req.user.id }
    });

    return ok(res, { report }, `Denúncia ${status.toLowerCase().replace('_', ' ')}.`);
  } catch (err) {
    logger.error(`[Admin.resolveReport] ${err.message}`);
    return serverError(res);
  }
};

// ─── Reports analytics ────────────────────────────────────────────
const reports = async (req, res) => {
  try {
    const topSellers = await prisma.bazar.findMany({
      orderBy: { totalSales: 'desc' }, take: 10,
      include: { seller: { select: { name: true } } }
    });

    const topProducts = await prisma.product.findMany({
      orderBy: { sales: 'desc' }, take: 10,
      select: { id: true, name: true, sales: true, price: true }
    });

    const byCategory = await prisma.product.groupBy({
      by: ['category'],
      _count: true,
      _sum: { sales: true },
      orderBy: { _sum: { sales: 'desc' } }
    });

    return ok(res, { topSellers, topProducts, byCategory });
  } catch (err) {
    logger.error(`[Admin.reports] ${err.message}`);
    return serverError(res);
  }
};

// ─── Audit logs ────────────────────────────────────────────────────
const auditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { take, skip } = paginate(page, limit);
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take, skip }),
      prisma.auditLog.count()
    ]);
    return ok(res, { logs, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Admin.auditLogs] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  overview, listUsers, toggleUser, verifySeller, messageUser, broadcast,
  listProducts, toggleProduct, listOrders, listReports, resolveReport, reports, auditLogs
};
