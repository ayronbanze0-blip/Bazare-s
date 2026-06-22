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

module.exports = router;
