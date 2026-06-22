'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { ok, created, badRequest, unauthorized, conflict, serverError, validationError } = require('../utils/response');
const { genCode, genToken, expiresAt } = require('../utils/helpers');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Token helpers ───────────────────────────────────────────────
const signAccess = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' }
  );

const signRefresh = () => genToken(48);

const createRefreshToken = async (userId, req) => {
  const token = signRefresh();
  const expiresInDays = 7;
  await prisma.refreshToken.create({
    data: {
      token,
      userId,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 3600 * 1000),
      userAgent: req.headers['user-agent']?.slice(0, 255),
      ipAddress: req.ip
    }
  });
  return token;
};

const setRefreshCookie = (res, token) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: isProd, // required by browsers whenever sameSite is 'none'
    // 'strict'/'lax' silently drop the cookie when frontend and backend
    // live on different domains (e.g. Vercel + Railway) — which is the
    // standard deploy topology for this project. 'none' is required for
    // that cross-site scenario; in local dev (http://localhost) browsers
    // still accept 'lax' so we only relax to 'none' in production.
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 3600 * 1000
  });
};

// ─── REGISTER ────────────────────────────────────────────────────
const register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { name, email, password, role = 'BUYER', inviteCode } = req.body;

  try {
    // Check email uniqueness
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return conflict(res, 'Este email já está registado.');

    // Handle revendedor invite
    let inviteId = null;
    let revendedorId = null;
    if (role === 'REVENDEDOR') {
      if (!inviteCode) return badRequest(res, 'Código de convite obrigatório para revendedores.');
      const invite = await prisma.revendedorInvite.findUnique({ where: { token: inviteCode } });
      if (!invite || invite.used) return badRequest(res, 'Código de convite inválido ou já utilizado.');
      if (invite.expiresAt && new Date() > invite.expiresAt) return badRequest(res, 'Código de convite expirado.');
      inviteId = invite.id;
      revendedorId = invite.createdById;

      // Mark invite as used
      await prisma.revendedorInvite.update({
        where: { id: invite.id },
        data: { used: true, usedAt: new Date() }
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role: role.toUpperCase(),
        inviteId,
        revendedorId
      }
    });

    // Generate verification code
    const code = genCode();
    await prisma.verificationCode.create({
      data: {
        userId: user.id,
        code,
        purpose: 'EMAIL_VERIFY',
        expiresAt: expiresAt(15)
      }
    });

    // Send verification email (non-blocking)
    emailSvc.sendVerificationEmail(user.email, user.name, code).catch(e =>
      logger.error(`[Register] Email send failed: ${e.message}`)
    );

    // Log registration
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'REGISTER', entity: 'User', ipAddress: req.ip }
    });

    logger.info(`[Auth] New user registered: ${user.email} (${user.role})`);

    return created(res, {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, verified: false }
    }, 'Conta criada. Verifique o seu email.');
  } catch (err) {
    logger.error(`[Register] ${err.message}`);
    return serverError(res, err.message);
  }
};

// ─── VERIFY EMAIL ────────────────────────────────────────────────
const verifyEmail = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { email, code } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');
    if (user.verified) return badRequest(res, 'Email já verificado.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || record.code !== code) return badRequest(res, 'Código inválido.');
    if (new Date() > record.expiresAt) return badRequest(res, 'Código expirado. Solicite um novo.');

    // Mark verified
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { verified: true, emailVerifiedAt: new Date() }
      }),
      prisma.verificationCode.update({
        where: { id: record.id },
        data: { usedAt: new Date() }
      })
    ]);

    // Issue tokens
    const accessToken = signAccess({ ...user, verified: true });
    const refreshToken = await createRefreshToken(user.id, req);
    setRefreshCookie(res, refreshToken);

    logger.info(`[Auth] Email verified: ${user.email}`);
    return ok(res, { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 'Email verificado com sucesso.');
  } catch (err) {
    logger.error(`[VerifyEmail] ${err.message}`);
    return serverError(res);
  }
};

// ─── RESEND VERIFICATION ─────────────────────────────────────────
const resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return badRequest(res, 'Email obrigatório.');

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return ok(res, {}, 'Se o email existir, receberá um código.');
    if (user.verified) return badRequest(res, 'Email já verificado.');

    // Invalidate old codes
    await prisma.verificationCode.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() }
    });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, purpose: 'EMAIL_VERIFY', expiresAt: expiresAt(15) }
    });

    emailSvc.sendVerificationEmail(user.email, user.name, code).catch(() => {});
    return ok(res, {}, 'Novo código enviado para o seu email.');
  } catch (err) {
    logger.error(`[ResendVerify] ${err.message}`);
    return serverError(res);
  }
};

// ─── LOGIN ────────────────────────────────────────────────────────
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { email, password } = req.body;

  try {
    // Check brute force (max 5 failed attempts in 15 min)
    const recentFails = await prisma.loginAttempt.count({
      where: {
        email: email.toLowerCase(),
        success: false,
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }
      }
    });
    if (recentFails >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Demasiadas tentativas falhadas. Aguarde 15 minutos.'
      });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    const logAttempt = (success) =>
      prisma.loginAttempt.create({
        data: {
          userId: user?.id || null,
          email: email.toLowerCase(),
          success,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']?.slice(0, 255)
        }
      }).catch(() => {});

    if (!user) {
      await logAttempt(false);
      return unauthorized(res, 'Credenciais incorrectas.');
    }
    if (!user.active) {
      await logAttempt(false);
      return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');
    }

    const validPw = await bcrypt.compare(password, user.passwordHash);
    if (!validPw) {
      await logAttempt(false);
      return unauthorized(res, 'Credenciais incorrectas.');
    }

    if (!user.verified) {
      await logAttempt(false);
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Email não verificado. Verifique a sua caixa de entrada.'
      });
    }

    // Issue tokens
    const accessToken = signAccess(user);
    const refreshToken = await createRefreshToken(user.id, req);
    setRefreshCookie(res, refreshToken);

    // Update last login
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await logAttempt(true);

    logger.info(`[Auth] Login: ${user.email} from ${req.ip}`);

    return ok(res, {
      accessToken,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, phone: user.phone, location: user.location,
        avatarUrl: user.avatarUrl, verifiedSeller: user.verifiedSeller,
        rating: user.rating, ratingCount: user.ratingCount
      }
    }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[Login] ${err.message}`);
    return serverError(res);
  }
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────
const refresh = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) return unauthorized(res, 'Refresh token não fornecido.');

  try {
    const record = await prisma.refreshToken.findUnique({ where: { token } });
    if (!record || record.revoked || new Date() > record.expiresAt) {
      return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
    }

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

    // Rotate refresh token
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revoked: true } });
    const newRefreshToken = await createRefreshToken(user.id, req);
    setRefreshCookie(res, newRefreshToken);

    const accessToken = signAccess(user);
    return ok(res, { accessToken }, 'Token renovado.');
  } catch (err) {
    logger.error(`[Refresh] ${err.message}`);
    return serverError(res);
  }
};

const clearRefreshCookie = (res) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax'
  });
};

// ─── LOGOUT ───────────────────────────────────────────────────────
const logout = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    await prisma.refreshToken.updateMany({
      where: { token },
      data: { revoked: true }
    }).catch(() => {});
  }
  clearRefreshCookie(res);
  return ok(res, {}, 'Sessão terminada.');
};

// ─── LOGOUT ALL (revoke all sessions) ────────────────────────────
const logoutAll = async (req, res) => {
  await prisma.refreshToken.updateMany({
    where: { userId: req.user.id },
    data: { revoked: true }
  }).catch(() => {});
  clearRefreshCookie(res);
  return ok(res, {}, 'Todas as sessões terminadas.');
};

// ─── FORGOT PASSWORD ──────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return badRequest(res, 'Email obrigatório.');

  // Always return same message to prevent email enumeration
  const msg = 'Se o email existir, receberá um código de redefinição.';

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return ok(res, {}, msg);

    // Invalidate existing reset codes
    await prisma.verificationCode.updateMany({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
      data: { usedAt: new Date() }
    });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, purpose: 'PASSWORD_RESET', expiresAt: expiresAt(15) }
    });

    emailSvc.sendPasswordResetEmail(user.email, user.name, code).catch(() => {});
    logger.info(`[Auth] Password reset requested: ${user.email}`);
    return ok(res, {}, msg);
  } catch (err) {
    logger.error(`[ForgotPassword] ${err.message}`);
    return ok(res, {}, msg); // Don't leak errors
  }
};

// ─── RESET PASSWORD ───────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { email, code, newPassword } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || record.code !== code) return badRequest(res, 'Código inválido.');
    if (new Date() > record.expiresAt) return badRequest(res, 'Código expirado.');

    const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.verificationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // Revoke all sessions for security
      prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } })
    ]);

    logger.info(`[Auth] Password reset: ${user.email}`);
    return ok(res, {}, 'Palavra-passe redefinida com sucesso. Faça login.');
  } catch (err) {
    logger.error(`[ResetPassword] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET CURRENT USER ─────────────────────────────────────────────
const me = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, location: true, bio: true,
        avatarUrl: true, coverUrl: true,
        verified: true, verifiedSeller: true, active: true,
        rating: true, ratingCount: true, cancelCount: true,
        revendedorId: true, createdAt: true, lastLoginAt: true,
        bazar: { select: { id: true, name: true, slug: true, active: true } },
        _count: {
          select: {
            orders: true,
            sellerOrders: true,
            favorites: true,
            cartItems: true
          }
        }
      }
    });
    if (!user || !user.active) return unauthorized(res, 'Utilizador não encontrado.');
    return ok(res, { user });
  } catch (err) {
    logger.error(`[Me] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  register, verifyEmail, resendVerification,
  login, refresh, logout, logoutAll,
  forgotPassword, resetPassword, me
};
