'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const FEE_LIMIT = parseFloat(process.env.FEE_LIMIT_MT) || 150;
const FEE_PAYMENT_NAME = process.env.FEE_PAYMENT_NAME || 'José Jeque';
const FEE_PAYMENT_NUMBER = process.env.FEE_PAYMENT_NUMBER || '84 676 1897';

// ─── SELLER: Finance overview ─────────────────────────────────────
const myFinance = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const { page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { sellerId: req.user.id },
        orderBy: { createdAt: 'desc' }, take, skip
      }),
      prisma.transaction.count({ where: { sellerId: req.user.id } })
    ]);

    return ok(res, {
      bazar: {
        totalSales: bazar.totalSales,
        pendingFees: bazar.pendingFees,
        paidFees: bazar.paidFees,
        feeRate: bazar.feeRate
      },
      feeLimit: FEE_LIMIT,
      feeLimitReached: bazar.pendingFees >= FEE_LIMIT,
      paymentInfo: { name: FEE_PAYMENT_NAME, number: FEE_PAYMENT_NUMBER },
      transactions,
      meta: paginateMeta(total, page, limit)
    });
  } catch (err) {
    logger.error(`[Finance.myFinance] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Submit fee payment proof ────────────────────────────
const submitPayment = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.pendingFees <= 0) return badRequest(res, 'Não há contribuição pendente.');

    const { reference } = req.body;

    // Notify all admins so they can validate the payment proof
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      notifSvc.push(admin.id, {
        type: 'INFO',
        title: 'Comprovativo de pagamento',
        message: `${req.user.name} (vendedor) submeteu comprovativo de ${bazar.pendingFees} MT${reference ? ` — Ref: ${reference}` : ''}.`,
        link: `/admin/sellers`
      });
    }

    return ok(res, {}, 'Comprovativo enviado. Aguarde validação do administrador.');
  } catch (err) {
    logger.error(`[Finance.submitPayment] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: Confirm payment (zeroes pending fee) ─────────────────
const confirmPayment = async (req, res) => {
  try {
    const { bazarId } = req.params;
    const bazar = await prisma.bazar.findUnique({ where: { id: bazarId } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const amount = bazar.pendingFees;
    if (amount <= 0) return badRequest(res, 'Não há contribuição pendente.');

    await prisma.$transaction([
      prisma.bazar.update({
        where: { id: bazarId },
        data: { paidFees: { increment: amount }, pendingFees: 0 }
      }),
      prisma.transaction.create({
        data: {
          bazarId, sellerId: bazar.sellerId, type: 'PAGAMENTO',
          amount, fee: 0, description: 'Pagamento de contribuição confirmado pelo administrador'
        }
      })
    ]);

    notifSvc.push(bazar.sellerId, {
      type: 'SUCCESS', title: 'Pagamento confirmado',
      message: `O seu pagamento de ${amount.toLocaleString('pt-MZ')} MT foi confirmado. Contador reiniciado.`,
      link: '/finance'
    });

    logger.info(`[Finance] Payment confirmed for bazar ${bazarId} by admin ${req.user.email}`);
    return ok(res, {}, 'Pagamento confirmado e contador reiniciado.');
  } catch (err) {
    logger.error(`[Finance.confirmPayment] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: Adjust/zero fee manually ─────────────────────────────
const adjustFee = async (req, res) => {
  try {
    const { bazarId } = req.params;
    const { newPendingFee, reason } = req.body;

    const bazar = await prisma.bazar.findUnique({ where: { id: bazarId } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const oldValue = bazar.pendingFees;
    const updated = await prisma.bazar.update({
      where: { id: bazarId },
      data: { pendingFees: Math.max(0, parseFloat(newPendingFee) || 0) }
    });

    await prisma.transaction.create({
      data: {
        bazarId, sellerId: bazar.sellerId, type: 'AJUSTE',
        amount: oldValue - updated.pendingFees, fee: 0,
        description: reason || 'Ajuste administrativo'
      }
    });

    notifSvc.push(bazar.sellerId, {
      type: 'INFO', title: 'Contribuição ajustada',
      message: `A sua contribuição pendente foi ajustada pelo administrador.`,
      link: '/finance'
    });

    return ok(res, { bazar: updated }, 'Contribuição ajustada.');
  } catch (err) {
    logger.error(`[Finance.adjustFee] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: Set fee rate per bazar ────────────────────────────────
const setFeeRate = async (req, res) => {
  try {
    const { bazarId } = req.params;
    const { feeRate } = req.body;
    const rate = parseFloat(feeRate);
    if (isNaN(rate) || rate < 0 || rate > 100) return badRequest(res, 'Taxa inválida.');

    const bazar = await prisma.bazar.update({
      where: { id: bazarId },
      data: { feeRate: rate }
    });

    notifSvc.push(bazar.sellerId, {
      type: 'INFO', title: 'Taxa actualizada',
      message: `A taxa da sua loja foi actualizada para ${rate}%.`,
      link: '/finance'
    });

    return ok(res, { bazar }, `Taxa definida para ${rate}%.`);
  } catch (err) {
    logger.error(`[Finance.setFeeRate] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: Platform-wide finance overview ───────────────────────
const platformFinance = async (req, res) => {
  try {
    const [totalSalesAgg, feesAgg, paidAgg, pendingAgg, bazars] = await Promise.all([
      prisma.order.aggregate({ where: { status: 'ENTREGUE' }, _sum: { total: true } }),
      prisma.transaction.aggregate({ where: { fee: { gt: 0 } }, _sum: { fee: true } }),
      prisma.bazar.aggregate({ _sum: { paidFees: true } }),
      prisma.bazar.aggregate({ _sum: { pendingFees: true } }),
      prisma.bazar.findMany({
        include: { seller: { select: { name: true, email: true } } },
        orderBy: { pendingFees: 'desc' }
      })
    ]);

    return ok(res, {
      totalSales: totalSalesAgg._sum.total || 0,
      totalFeesGenerated: feesAgg._sum.fee || 0,
      totalPaid: paidAgg._sum.paidFees || 0,
      totalPending: pendingAgg._sum.pendingFees || 0,
      feeLimit: FEE_LIMIT,
      bazars: bazars.map(b => ({
        id: b.id, name: b.name, sellerName: b.seller.name, sellerEmail: b.seller.email,
        totalSales: b.totalSales, pendingFees: b.pendingFees, paidFees: b.paidFees,
        feeRate: b.feeRate, limitReached: b.pendingFees >= FEE_LIMIT
      }))
    });
  } catch (err) {
    logger.error(`[Finance.platformFinance] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: All transactions ───────────────────────────────────────
const allTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { take, skip } = paginate(page, limit);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        orderBy: { createdAt: 'desc' }, take, skip,
        include: { bazar: { select: { name: true } } }
      }),
      prisma.transaction.count()
    ]);
    return ok(res, { transactions, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Finance.allTransactions] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  myFinance, submitPayment, confirmPayment, adjustFee,
  setFeeRate, platformFinance, allTransactions
};
