'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { genToken, paginate, paginateMeta } = require('../utils/helpers');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const MAX_REVENDEDORES = 20;

// ─── ADMIN: Generate invite ────────────────────────────────────────
const generateInvite = async (req, res) => {
  try {
    const count = await prisma.user.count({ where: { role: 'REVENDEDOR' } });
    if (count >= MAX_REVENDEDORES) return badRequest(res, `Limite de ${MAX_REVENDEDORES} revendedores atingido.`);

    const { note, expiresInDays } = req.body;
    const token = 'BZR-' + genToken(8).toUpperCase();

    const invite = await prisma.revendedorInvite.create({
      data: {
        token,
        note: note || null,
        createdById: req.user.id,
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 3600 * 1000) : null
      }
    });

    const baseUrl = process.env.FRONTEND_URL || 'https://bazares.co.mz';
    const links = {
      register: `${baseUrl}/register?invite=${token}`,
      invite: `${baseUrl}/invite/${token}`,
      revendedor: `${baseUrl}/revendedor/${token}`,
      ref: `${baseUrl}/ref/${token}`
    };

    logger.info(`[Revendedor] Invite generated: ${token} by ${req.user.email}`);
    return created(res, { invite, links }, 'Convite gerado com sucesso.');
  } catch (err) {
    logger.error(`[Revendedor.generateInvite] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: List all invites ────────────────────────────────────────
const listInvites = async (req, res) => {
  try {
    const invites = await prisma.revendedorInvite.findMany({
      orderBy: { createdAt: 'desc' },
      include: { usedByUsers: { select: { id: true, name: true, email: true } } }
    });
    return ok(res, { invites });
  } catch (err) {
    logger.error(`[Revendedor.listInvites] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: Revoke invite ───────────────────────────────────────────
const revokeInvite = async (req, res) => {
  try {
    const invite = await prisma.revendedorInvite.findUnique({ where: { id: req.params.id } });
    if (!invite) return notFound(res);
    if (invite.used) return badRequest(res, 'Convite já utilizado, não pode ser revogado.');
    await prisma.revendedorInvite.delete({ where: { id: invite.id } });
    return ok(res, {}, 'Convite revogado.');
  } catch (err) {
    logger.error(`[Revendedor.revokeInvite] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Validate invite token ───────────────────────────────────
const validateInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const invite = await prisma.revendedorInvite.findUnique({ where: { token } });
    if (!invite) return notFound(res, 'Convite não encontrado.');
    if (invite.used) return badRequest(res, 'Este convite já foi utilizado.');
    if (invite.expiresAt && new Date() > invite.expiresAt) return badRequest(res, 'Convite expirado.');
    return ok(res, { valid: true });
  } catch (err) {
    logger.error(`[Revendedor.validateInvite] ${err.message}`);
    return serverError(res);
  }
};

// ─── REVENDEDOR: My sellers ──────────────────────────────────────────
const mySellers = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const [sellers, total] = await Promise.all([
      prisma.user.findMany({
        where: { revendedorId: req.user.id, role: 'SELLER' },
        take, skip, orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, email: true, active: true, createdAt: true,
          bazar: { select: { id: true, name: true, totalSales: true, pendingFees: true } }
        }
      }),
      prisma.user.count({ where: { revendedorId: req.user.id, role: 'SELLER' } })
    ]);

    return ok(res, { sellers, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Revendedor.mySellers] ${err.message}`);
    return serverError(res);
  }
};

// ─── REVENDEDOR/USER: My referral stats ──────────────────────────────
const myReferralStats = async (req, res) => {
  try {
    const directReferrals = await prisma.user.findMany({
      where: { revendedorId: req.user.id },
      select: { id: true, name: true, role: true, active: true, createdAt: true }
    });

    const myInvites = await prisma.revendedorInvite.findMany({
      where: { createdById: req.user.id },
      include: { usedByUsers: { select: { id: true, name: true } } }
    });

    const totalSales = await prisma.bazar.aggregate({
      where: { sellerId: { in: directReferrals.map(u => u.id) } },
      _sum: { totalSales: true }
    });

    const baseUrl = process.env.FRONTEND_URL || 'https://bazares.co.mz';

    return ok(res, {
      referralLinks: {
        ref: `${baseUrl}/ref/${req.user.id}`,
        revendedor: `${baseUrl}/revendedor/${req.user.id}`
      },
      stats: {
        totalReferrals: directReferrals.length + myInvites.filter(i => i.used).length,
        directReferrals: directReferrals.length,
        invitesSent: myInvites.length,
        invitesUsed: myInvites.filter(i => i.used).length,
        invitesPending: myInvites.filter(i => !i.used).length,
        totalSalesVolume: totalSales._sum.totalSales || 0
      },
      referrals: directReferrals,
      invites: myInvites
    });
  } catch (err) {
    logger.error(`[Revendedor.myReferralStats] ${err.message}`);
    return serverError(res);
  }
};

// ─── REVENDEDOR: Finance of my sellers ───────────────────────────────
const myFinance = async (req, res) => {
  try {
    const sellers = await prisma.user.findMany({
      where: { revendedorId: req.user.id, role: 'SELLER' },
      select: { id: true }
    });
    const sellerIds = sellers.map(s => s.id);

    const transactions = await prisma.transaction.findMany({
      where: { sellerId: { in: sellerIds } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { bazar: { select: { name: true } } }
    });

    return ok(res, { transactions });
  } catch (err) {
    logger.error(`[Revendedor.myFinance] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  generateInvite, listInvites, revokeInvite, validateInvite,
  mySellers, myReferralStats, myFinance
};
