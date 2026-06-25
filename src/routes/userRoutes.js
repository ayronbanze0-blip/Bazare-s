'use strict';

const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { authenticate } = require('../middleware/auth');
const { ok, badRequest, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const { upload, uploadAvatar } = require('../services/uploadService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Update profile ────────────────────────────────────────────────
router.put('/me', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    const { name, bio, phone, location } = req.body;
    const data = {};
    if (name) data.name = sanitize(name);
    if (bio !== undefined) data.bio = sanitize(bio);
    if (phone !== undefined) data.phone = phone;
    if (location !== undefined) data.location = location;

    if (req.file) {
      const result = await uploadAvatar(req.file.path);
      if (result.ok) data.avatarUrl = result.url;
    }

    const user = await prisma.user.update({ where: { id: req.user.id }, data });
    return ok(res, {
      user: {
        id: user.id, name: user.name, bio: user.bio,
        phone: user.phone, location: user.location, avatarUrl: user.avatarUrl
      }
    }, 'Perfil actualizado.');
  } catch (err) {
    logger.error(`[Profile.update] ${err.message}`);
    return serverError(res);
  }
});

// ─── Change password ───────────────────────────────────────────────
router.put('/me/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return badRequest(res, 'Preencha todos os campos.');
    if (newPassword.length < 8) return badRequest(res, 'Nova palavra-passe muito curta.');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return badRequest(res, 'Palavra-passe actual incorrecta.');

    const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all other sessions for security
    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } });

    return ok(res, {}, 'Palavra-passe alterada com sucesso. Faça login novamente.');
  } catch (err) {
    logger.error(`[Profile.changePassword] ${err.message}`);
    return serverError(res);
  }
});

// ─── Public profile (seller) ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, name: true, bio: true, avatarUrl: true, coverUrl: true,
        role: true, rating: true, ratingCount: true, verifiedSeller: true,
        createdAt: true,
        bazar: { select: { id: true, name: true, slug: true } }
      }
    });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');
    return ok(res, { user });
  } catch (err) {
    logger.error(`[Profile.getPublic] ${err.message}`);
    return serverError(res);
  }
});

// ─── Delete account (irreversible — wipes all user data) ──────────
router.delete('/me', authenticate, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');

    // Block deletion for ADMIN accounts to avoid orphaning the platform.
    if (user.role === 'ADMIN') {
      return badRequest(res, 'Contas de administrador não podem ser eliminadas por aqui.');
    }

    const bazar = await prisma.bazar.findUnique({ where: { sellerId: userId } });
    const productIds = bazar
      ? (await prisma.product.findMany({ where: { bazarId: bazar.id }, select: { id: true } })).map(p => p.id)
      : [];
    const orderIds = (await prisma.order.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      select: { id: true }
    })).map(o => o.id);

    await prisma.$transaction(async (tx) => {
      // ── Chat & messages (both as sender and as chat participant) ──
      const chats = await tx.chat.findMany({
        where: { OR: [{ userAId: userId }, { userBId: userId }] },
        select: { id: true }
      });
      const chatIds = chats.map(c => c.id);
      if (chatIds.length) await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.message.deleteMany({ where: { senderId: userId } });
      if (chatIds.length) await tx.chat.deleteMany({ where: { id: { in: chatIds } } });

      // ── Notifications, favorites, cart, tokens, codes, login attempts ──
      await tx.notification.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.cartItem.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.verificationCode.deleteMany({ where: { userId } });
      await tx.loginAttempt.updateMany({ where: { userId }, data: { userId: null } });

      // ── Reports made by or against this user ──
      await tx.report.deleteMany({ where: { OR: [{ reporterId: userId }, { targetUserId: userId }] } });

      // ── Orders (as buyer or seller) and everything chained to them ──
      if (orderIds.length) {
        await tx.review.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.transaction.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      // Reviews where this user is the seller being reviewed (not tied to their own orders)
      await tx.review.deleteMany({ where: { sellerId: userId } });

      // ── Bazar + products (as seller) ──
      if (productIds.length) {
        await tx.report.deleteMany({ where: { targetProductId: { in: productIds } } });
        await tx.review.deleteMany({ where: { productId: { in: productIds } } });
        await tx.favorite.deleteMany({ where: { productId: { in: productIds } } });
        await tx.cartItem.deleteMany({ where: { productId: { in: productIds } } });
        await tx.orderItem.deleteMany({ where: { productId: { in: productIds } } });
        await tx.productImage.deleteMany({ where: { productId: { in: productIds } } });
        await tx.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (bazar) {
        await tx.transaction.deleteMany({ where: { bazarId: bazar.id } });
        await tx.bazar.delete({ where: { id: bazar.id } });
      }

      // ── Revendedor relationships ──
      await tx.revendedorInvite.deleteMany({ where: { createdById: userId } });
      await tx.user.updateMany({ where: { revendedorId: userId }, data: { revendedorId: null } });

      // ── Finally, the user record itself ──
      await tx.user.delete({ where: { id: userId } });
    });

    logger.info(`[Account] Deleted by self: ${user.email} (${user.role})`);

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    });

    return ok(res, {}, 'Conta eliminada com sucesso.');
  } catch (err) {
    logger.error(`[Profile.deleteAccount] ${err.message}`);
    return serverError(res, 'Não foi possível eliminar a conta. Tente novamente.');
  }
});

module.exports = router;
