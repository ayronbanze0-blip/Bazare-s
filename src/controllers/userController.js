'use strict';

const bcrypt = require('bcryptjs');
const { ok, badRequest, notFound, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const { uploadAvatar, uploadBazarBanner } = require('../services/uploadService');
const walletService = require('../services/walletService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── GET /api/users/me/stats ──────────────────────────────────────
// Dashboard stats do utilizador autenticado (comprador ou vendedor).
const myStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const isSeller = ['SELLER', 'ADMIN', 'REVENDEDOR'].includes(req.user.role);

    const [
      totalOrders,
      pendingOrders,
      totalFavorites,
      cartCount,
      unreadMessages,
      unreadNotifications
    ] = await Promise.all([
      prisma.order.count({ where: { buyerId: userId } }),
      prisma.order.count({ where: { buyerId: userId, status: 'PENDENTE' } }),
      prisma.favorite.count({ where: { userId } }),
      prisma.cartItem.count({ where: { userId } }),
      prisma.message.count({
        where: {
          read: false,
          senderId: { not: userId },
          chat: { OR: [{ userAId: userId }, { userBId: userId }] }
        }
      }),
      prisma.notification.count({ where: { userId, read: false } })
    ]);

    let sellerStats = null;
    if (isSeller) {
      const bazar = await prisma.bazar.findUnique({ where: { sellerId: userId } });
      if (bazar) {
        const [receivedOrders, pendingSellerOrders] = await Promise.all([
          prisma.order.count({ where: { sellerId: userId } }),
          prisma.order.count({ where: { sellerId: userId, status: 'PENDENTE' } })
        ]);
        sellerStats = {
          bazarId: bazar.id,
          totalSales: bazar.totalSales,
          pendingFees: bazar.pendingFees,
          receivedOrders,
          pendingSellerOrders
        };
      }
    }

    const walletBalance = await walletService.getBalance(prisma, userId);

    return ok(res, {
      totalOrders,
      pendingOrders,
      totalFavorites,
      cartCount,
      unreadMessages,
      unreadNotifications,
      walletBalance,
      seller: sellerStats
    });
  } catch (err) {
    logger.error(`[Users.myStats] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUT /api/users/me ────────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const { name, bio, phone, location } = req.body;
    const data = {};
    if (name) data.name = sanitize(name);
    if (bio !== undefined) data.bio = sanitize(bio);
    if (phone !== undefined) data.phone = phone;
    if (location !== undefined) data.location = location;

    let avatarUploadError = null;
    if (req.file) {
      const result = await uploadAvatar(req.file.path);
      if (result.ok) data.avatarUrl = result.url;
      else avatarUploadError = result.error;
    }

    const user = await prisma.user.update({ where: { id: req.user.id }, data });
    return ok(res, {
      user: {
        id: user.id, name: user.name, bio: user.bio,
        phone: user.phone, location: user.location, avatarUrl: user.avatarUrl
      },
      avatarUploadError
    }, avatarUploadError ? `Perfil actualizado, mas a foto falhou: ${avatarUploadError}` : 'Perfil actualizado.');
  } catch (err) {
    logger.error(`[Users.updateProfile] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUT /api/users/me/cover ──────────────────────────────────────
const updateCover = async (req, res) => {
  try {
    if (!req.file) return badRequest(res, 'Imagem de capa obrigatória.');
    const result = await uploadBazarBanner(req.file.path);
    if (!result.ok) return serverError(res, result.error);
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { coverUrl: result.url }
    });
    return ok(res, { coverUrl: user.coverUrl }, 'Foto de capa actualizada.');
  } catch (err) {
    logger.error(`[Users.updateCover] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUT /api/users/me/password ───────────────────────────────────
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return badRequest(res, 'Preencha todos os campos.');
    if (newPassword.length < 8) return badRequest(res, 'Nova palavra-passe muito curta (mín. 8 caracteres).');
    if (currentPassword === newPassword) return badRequest(res, 'A nova palavra-passe não pode ser igual à actual.');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return badRequest(res, 'Palavra-passe actual incorrecta.');

    const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoga todas as sessões — utilizador terá de fazer login novamente
    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } });

    return ok(res, {}, 'Palavra-passe alterada com sucesso. Faça login novamente.');
  } catch (err) {
    logger.error(`[Users.changePassword] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/users/:id ───────────────────────────────────────────
// Perfil público (qualquer utilizador pode ver o perfil de um vendedor)
const publicProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id, active: true },
      select: {
        id: true, name: true, bio: true, avatarUrl: true, coverUrl: true,
        role: true, rating: true, ratingCount: true, verifiedSeller: true,
        isPremium: true,
        thumbsUp: true, thumbsDown: true,
        createdAt: true,
        bazar: {
          select: {
            id: true, name: true, slug: true, description: true,
            category: true, location: true, bannerUrl: true, logoUrl: true,
            totalSales: true, active: true,
            _count: { select: { products: { where: { active: true } } } }
          }
        },
        _count: { select: { sellerOrders: true, reviewsReceived: true } }
      }
    });
    if (!user) return notFound(res, 'Utilizador não encontrado.');

    let myVote = null;
    if (req.user?.id) {
      const vote = await prisma.sellerThumbVote.findUnique({
        where: { voterId_sellerId: { voterId: req.user.id, sellerId: req.params.id } }
      });
      myVote = vote ? vote.vote.toLowerCase() : null;
    }

    return ok(res, { user, myVote });
  } catch (err) {
    logger.error(`[Users.publicProfile] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/users/:id/thumb ─────────────────────────────────────
// Voto 👍/👎 de um comprador na reputação de um vendedor. Um voto por
// comprador — votar de novo com o mesmo sentido remove o voto (toggle),
// votar com o sentido oposto troca-o.
const sendThumb = async (req, res) => {
  try {
    const sellerId = req.params.id;
    const { thumb } = req.body;
    if (!['up', 'down'].includes(thumb)) return badRequest(res, 'Voto inválido.');
    if (sellerId === req.user.id) return badRequest(res, 'Não pode votar em si próprio.');

    const seller = await prisma.user.findUnique({ where: { id: sellerId }, select: { id: true } });
    if (!seller) return notFound(res, 'Utilizador não encontrado.');

    const vote = thumb === 'up' ? 'UP' : 'DOWN';
    const existing = await prisma.sellerThumbVote.findUnique({
      where: { voterId_sellerId: { voterId: req.user.id, sellerId } }
    });

    const inc = { thumbsUp: 0, thumbsDown: 0 };
    let myVote = vote.toLowerCase();

    if (!existing) {
      await prisma.sellerThumbVote.create({ data: { voterId: req.user.id, sellerId, vote } });
      inc[vote === 'UP' ? 'thumbsUp' : 'thumbsDown'] = 1;
    } else if (existing.vote === vote) {
      // Mesmo voto de novo — remove (toggle off)
      await prisma.sellerThumbVote.delete({ where: { id: existing.id } });
      inc[vote === 'UP' ? 'thumbsUp' : 'thumbsDown'] = -1;
      myVote = null;
    } else {
      // Voto oposto — troca
      await prisma.sellerThumbVote.update({ where: { id: existing.id }, data: { vote } });
      inc[existing.vote === 'UP' ? 'thumbsUp' : 'thumbsDown'] = -1;
      inc[vote === 'UP' ? 'thumbsUp' : 'thumbsDown'] = 1;
    }

    const updated = await prisma.user.update({
      where: { id: sellerId },
      data: { thumbsUp: { increment: inc.thumbsUp }, thumbsDown: { increment: inc.thumbsDown } },
      select: { thumbsUp: true, thumbsDown: true }
    });

    return ok(res, { thumbsUp: updated.thumbsUp, thumbsDown: updated.thumbsDown, myVote });
  } catch (err) {
    logger.error(`[Users.sendThumb] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/users/me ─────────────────────────────────────────
const deleteAccount = async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return notFound(res, 'Utilizador não encontrado.');
    if (user.role === 'ADMIN') return badRequest(res, 'Contas de administrador não podem ser eliminadas por aqui.');

    const bazar = await prisma.bazar.findUnique({ where: { sellerId: userId } });
    const productIds = bazar
      ? (await prisma.product.findMany({ where: { bazarId: bazar.id }, select: { id: true } })).map(p => p.id)
      : [];
    const orderIds = (await prisma.order.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      select: { id: true }
    })).map(o => o.id);

    await prisma.$transaction(async (tx) => {
      const chats = await tx.chat.findMany({
        where: { OR: [{ userAId: userId }, { userBId: userId }] },
        select: { id: true }
      });
      const chatIds = chats.map(c => c.id);
      if (chatIds.length) await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.message.deleteMany({ where: { senderId: userId } });
      if (chatIds.length) await tx.chat.deleteMany({ where: { id: { in: chatIds } } });

      await tx.notification.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.cartItem.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.verificationCode.deleteMany({ where: { userId } });
      await tx.loginAttempt.updateMany({ where: { userId }, data: { userId: null } });
      await tx.report.deleteMany({ where: { OR: [{ reporterId: userId }, { targetUserId: userId }] } });

      if (orderIds.length) {
        await tx.review.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.transaction.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await tx.review.deleteMany({ where: { sellerId: userId } });

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

      await tx.revendedorInvite.deleteMany({ where: { createdById: userId } });
      await tx.user.updateMany({ where: { revendedorId: userId }, data: { revendedorId: null } });
      await tx.user.delete({ where: { id: userId } });
    });

    logger.info(`[Account] Deleted by self: ${user.email} (${user.role})`);
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie('refreshToken', { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' });
    return ok(res, {}, 'Conta eliminada com sucesso.');
  } catch (err) {
    logger.error(`[Users.deleteAccount] ${err.message}`);
    return serverError(res, 'Não foi possível eliminar a conta. Tente novamente.');
  }
};

// ─── PUT /api/users/me/onboarding ──────────────────────────────────
// Guarda as respostas do formulário curto mostrado logo após o registo.
// Se a pessoa disser que quer vender, promovemos a conta de BUYER para
// SELLER aqui mesmo — é o único lugar hoje que faz essa promoção, já
// que o registo deixou de perguntar "tipo de conta" antecipadamente.
const onboarding = async (req, res) => {
  try {
    const { intent, hasPhysicalStore, referralSource } = req.body;
    if (intent && !['BUY', 'SELL'].includes(intent)) {
      return badRequest(res, 'Intenção inválida.');
    }

    const data = { onboardedAt: new Date() };
    if (typeof hasPhysicalStore === 'boolean') data.hasPhysicalStore = hasPhysicalStore;
    if (referralSource) data.referralSource = sanitize(String(referralSource)).slice(0, 60);

    // Só promove BUYER -> SELLER. Nunca reduz ou altera REVENDEDOR/ADMIN
    // (ex: se por algum motivo esta rota for chamada duas vezes, ou por
    // uma conta que já não é BUYER).
    if (intent === 'SELL' && req.user.role === 'BUYER') {
      data.role = 'SELLER';
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true, name: true, email: true, role: true, avatarUrl: true,
        hasPhysicalStore: true, referralSource: true, onboardedAt: true
      }
    });

    return ok(res, { user }, 'Preferências guardadas.');
  } catch (err) {
    logger.error(`[Users.onboarding] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/users/me/request-verification ──────────────────────
// Pedido de verificação de vendedor. Não verifica automaticamente —
// só marca a data do pedido para entrar na fila do admin. Contas
// Premium aparecem primeiro nessa fila (ver adminController.listUsers).
const requestVerification = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return notFound(res);
    if (user.verifiedSeller) return badRequest(res, 'A sua conta já está verificada.');
    if (user.verificationRequestedAt) {
      const daysSince = (Date.now() - new Date(user.verificationRequestedAt).getTime()) / 86400000;
      if (daysSince < 7) return badRequest(res, 'Já tem um pedido de verificação em análise. Aguarde a resposta da equipa Bazares.');
    }

    await prisma.user.update({ where: { id: user.id }, data: { verificationRequestedAt: new Date() } });
    logger.info(`[Users.requestVerification] ${user.email} pediu verificação${user.isPremium ? ' (Premium — prioridade)' : ''}.`);
    return ok(res, {}, 'Pedido enviado! A equipa Bazares vai rever a sua conta em breve.');
  } catch (err) {
    logger.error(`[Users.requestVerification] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { myStats, updateProfile, updateCover, changePassword, publicProfile, sendThumb, deleteAccount, onboarding, requestVerification };

