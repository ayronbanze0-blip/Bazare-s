'use strict';


const { ok, badRequest, notFound, conflict, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');

const prisma = require('../config/database');

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


// ─── Admin: Adjust bazar feeRate ────────────────────────────────
const setBazarFeeRate = async (req, res) => {
  try {
    const { feeRate } = req.body;
    const rate = parseFloat(feeRate);
    if (isNaN(rate) || rate < 0 || rate > 20) return badRequest(res, 'Taxa inválida (0–20%).');
    const bazar = await prisma.bazar.findUnique({ where: { id: req.params.bazarId } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    const updated = await prisma.bazar.update({ where: { id: bazar.id }, data: { feeRate: rate } });
    notifSvc.push(bazar.sellerId, {
      type: 'INFO',
      title: 'Taxa de contribuição actualizada',
      message: `A sua taxa de contribuição foi ajustada para ${rate}% pelo administrador.`,
      link: '/finance'
    });
    logger.info(`[Admin] feeRate for bazar ${bazar.id} set to ${rate}% by ${req.user.email}`);
    return ok(res, { bazar: updated }, 'Taxa actualizada.');
  } catch (err) {
    logger.error(`[Admin.setBazarFeeRate] ${err.message}`);
    return serverError(res);
  }
};

// ─── Admin: Toggle featured product ─────────────────────────────
const toggleFeatured = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res, 'Produto não encontrado.');
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { featured: !product.featured }
    });
    notifSvc.push(product.sellerId, {
      type: updated.featured ? 'SUCCESS' : 'INFO',
      title: updated.featured ? '⭐ Produto em destaque!' : 'Produto removido do destaque',
      message: `"${product.name}" foi ${updated.featured ? 'adicionado ao' : 'removido do'} destaque da plataforma.`
    });
    return ok(res, { featured: updated.featured }, `Produto ${updated.featured ? 'destacado' : 'removido do destaque'}.`);
  } catch (err) {
    logger.error(`[Admin.toggleFeatured] ${err.message}`);
    return serverError(res);
  }
};

// ─── Delete user permanently ──────────────────────────────────────
// O schema já faz cascade automático para Bazar→Product→CartItem/Favorite,
// Wallet→WalletTransaction, Chat→Message, Thumb e RefreshToken ao apagar o
// User. Mas Order (buyer/seller), Review e Transaction referenciam o User
// sem cascade — se não forem tratados à mão primeiro, o delete falha com
// violação de foreign key. Por isso: 1) apaga Reviews das encomendas do
// utilizador, 2) desliga (orderId=null) as Transactions dessas encomendas
// para não apagar o histórico financeiro da OUTRA parte, 3) apaga as
// Orders, 4) apaga as Transactions do próprio utilizador, 5) apaga
// RevendedorInvites não usados criados por ele, e só depois 6) apaga o User.
const deleteUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return notFound(res);
    if (user.role === 'ADMIN') return badRequest(res, 'Não é possível eliminar um administrador.');

    const orders = await prisma.order.findMany({
      where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
      select: { id: true }
    });
    const orderIds = orders.map(o => o.id);

    await prisma.$transaction([
      prisma.review.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.transaction.updateMany({ where: { orderId: { in: orderIds } }, data: { orderId: null } }),
      prisma.order.deleteMany({ where: { id: { in: orderIds } } }),
      prisma.transaction.deleteMany({ where: { sellerId: user.id } }),
      prisma.revendedorInvite.deleteMany({ where: { createdById: user.id, used: false } }),
      prisma.user.delete({ where: { id: user.id } })
    ]);

    logger.info(`[Admin] User deleted: ${user.email} (${user.id}) by ${req.user.email}`);
    return ok(res, {}, 'Conta eliminada definitivamente.');
  } catch (err) {
    if (err.code === 'P2003') {
      logger.error(`[Admin.deleteUser] FK constraint: ${err.message}`);
      return conflict(res, 'Não foi possível eliminar: existem dados associados que ainda não podem ser removidos (ex: convites de revendedor já usados).');
    }
    logger.error(`[Admin.deleteUser] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  overview, listUsers, toggleUser, verifySeller, messageUser, broadcast, deleteUser,
  listProducts, toggleProduct, toggleFeatured, listOrders, listReports, resolveReport, reports, auditLogs,
  setBazarFeeRate
};

