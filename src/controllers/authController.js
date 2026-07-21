'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');


const { ok, created, badRequest, unauthorized, conflict, serverError, validationError } = require('../utils/response');
const { genCode, genToken, expiresAt } = require('../utils/helpers');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');
// NOTE: emailSvc e genCode/expiresAt continuam a ser usados em
// forgotPassword/resetPassword (recuperação de password). A verificação
// de email no REGISTO foi removida — a conta fica "verified: true" logo.

const prisma = require('../config/database');

const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

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

      // Reclama o convite de forma atómica: só marca como usado se ainda
      // estiver por usar neste preciso momento. Duas tentativas de registo
      // concorrentes com o mesmo código (ex: link partilhado, duplo clique)
      // só deixam UMA passar — a pré-verificação acima é só para dar um
      // erro rápido e amigável, esta é a garantia real contra reutilização.
      const claim = await prisma.revendedorInvite.updateMany({
        where: { id: invite.id, used: false },
        data: { used: true, usedAt: new Date() }
      });
      if (claim.count === 0) return badRequest(res, 'Código de convite inválido ou já utilizado.');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    // Create user — já fica verificado, sem fluxo de verificação por email
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role: role.toUpperCase(),
        inviteId,
        revendedorId,
        verified: true,
        emailVerifiedAt: new Date()
      }
    });

    // Log registration
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'REGISTER', entity: 'User', ipAddress: req.ip }
    });

    logger.info(`[Auth] New user registered: ${user.email} (${user.role})`);

    return created(res, {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, verified: true }
    }, 'Conta criada com sucesso. Faça login para continuar.');
  } catch (err) {
    logger.error(`[Register] ${err.message}`);
    return serverError(res, err.message);
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
      refreshToken,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, phone: user.phone, location: user.location,
        avatarUrl: user.avatarUrl, verifiedSeller: user.verifiedSeller,
        rating: user.rating, ratingCount: user.ratingCount, onboardedAt: user.onboardedAt
      }
    }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[Login] ${err.message}`);
    return serverError(res);
  }
};

// ─── LOGIN SOCIAL (Google / Facebook / Apple) ─────────────────────
// Todos os três seguem o mesmo padrão: o frontend obtém um token do SDK
// da plataforma (Google Identity Services / Facebook SDK / Apple JS),
// envia-o para aqui, nós validamos esse token directamente junto do
// provider (nunca confiamos em dados vindos do cliente sem verificar),
// e depois criamos/associamos a conta local e emitimos os NOSSOS
// próprios tokens (accessToken + refreshToken), exactamente como no
// login normal — assim o resto da app nem sabe que a origem foi social.

const buildUserResponse = (user) => ({
  id: user.id, name: user.name, email: user.email,
  role: user.role, phone: user.phone, location: user.location,
  avatarUrl: user.avatarUrl, verifiedSeller: user.verifiedSeller,
  rating: user.rating, ratingCount: user.ratingCount, onboardedAt: user.onboardedAt
});

const issueSessionFor = async (user, req, res) => {
  const accessToken = signAccess(user);
  const refreshToken = await createRefreshToken(user.id, req);
  setRefreshCookie(res, refreshToken);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { accessToken, refreshToken };
};

// Encontra o utilizador pela ligação social já existente; se não houver,
// tenta associar por email (ex: já tinha conta normal com o mesmo email);
// caso contrário cria uma conta nova, já verificada e sem password.
const findOrCreateSocialUser = async ({ provider, providerId, email, name, avatarUrl }) => {
  let user = await prisma.user.findFirst({ where: { provider, providerId } });
  if (user) return user;

  if (email) {
    user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user) {
      return prisma.user.update({
        where: { id: user.id },
        data: {
          provider: user.provider || provider,
          providerId: user.providerId || providerId,
          avatarUrl: user.avatarUrl || avatarUrl || null
        }
      });
    }
  }

  return prisma.user.create({
    data: {
      name: (name || 'Utilizador Bazares').trim(),
      email: email
        ? email.toLowerCase().trim()
        : `${provider}_${providerId}@social.bazares.local`,
      passwordHash: null,
      provider,
      providerId,
      avatarUrl: avatarUrl || null,
      role: 'BUYER',
      verified: true,
      emailVerifiedAt: new Date()
    }
  });
};

// ─── GOOGLE LOGIN ──────────────────────────────────────────────────
// Recebe o "credential" (ID token JWT) do Google Identity Services.
const googleLogin = async (req, res) => {
  if (!googleClient) return serverError(res, 'Login com Google ainda não configurado no servidor.');

  const { idToken } = req.body;
  if (!idToken) return badRequest(res, 'Token do Google em falta.');

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) return unauthorized(res, 'Token do Google inválido.');

    const user = await findOrCreateSocialUser({
      provider: 'google',
      providerId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Google login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[GoogleLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Google.');
  }
};

// ─── FACEBOOK LOGIN ─────────────────────────────────────────────────
// Recebe o accessToken devolvido pelo Facebook SDK (FB.login) e valida-o
// junto da Graph API, com appsecret_proof para reforçar a segurança.
const facebookLogin = async (req, res) => {
  if (!process.env.FACEBOOK_APP_SECRET) return serverError(res, 'Login com Facebook ainda não configurado no servidor.');

  const { accessToken: fbToken } = req.body;
  if (!fbToken) return badRequest(res, 'Token do Facebook em falta.');

  try {
    const proof = crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(fbToken).digest('hex');
    const url = `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(fbToken)}&appsecret_proof=${proof}`;
    const fbRes = await fetch(url);
    const fbData = await fbRes.json();
    if (!fbData?.id) return unauthorized(res, 'Token do Facebook inválido.');

    const user = await findOrCreateSocialUser({
      provider: 'facebook',
      providerId: fbData.id,
      email: fbData.email,
      name: fbData.name,
      avatarUrl: fbData.picture?.data?.url
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Facebook login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[FacebookLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Facebook.');
  }
};

// ─── APPLE LOGIN ────────────────────────────────────────────────────
// Pronto a usar assim que tiveres a Apple Developer Program: recebe o
// identityToken (JWT) devolvido pelo "Sign in with Apple JS". Valida a
// assinatura contra as chaves públicas da Apple (JWKS), sem precisar de
// nenhuma lib extra além do próprio jsonwebtoken + jwks-rsa.
// Falta por configurar: APPLE_CLIENT_ID (o teu Service ID) no .env.
let appleJwks = null;
const getApplePublicKey = async (kid) => {
  if (!appleJwks) {
    const res = await fetch('https://appleid.apple.com/auth/keys');
    appleJwks = (await res.json()).keys;
  }
  const key = appleJwks.find((k) => k.kid === kid);
  if (!key) { appleJwks = null; throw new Error('Chave Apple não encontrada.'); }
  return crypto.createPublicKey({ key, format: 'jwk' });
};

const appleLogin = async (req, res) => {
  if (!process.env.APPLE_CLIENT_ID) return serverError(res, 'Login com Apple ainda não configurado no servidor (falta Apple Developer Program).');

  const { identityToken, name: appleName } = req.body;
  if (!identityToken) return badRequest(res, 'Token da Apple em falta.');

  try {
    const decodedHeader = jwt.decode(identityToken, { complete: true });
    if (!decodedHeader?.header?.kid) return unauthorized(res, 'Token da Apple inválido.');

    const publicKey = await getApplePublicKey(decodedHeader.header.kid);
    const payload = jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      audience: process.env.APPLE_CLIENT_ID,
      issuer: 'https://appleid.apple.com'
    });
    if (!payload?.sub) return unauthorized(res, 'Token da Apple inválido.');

    // A Apple só envia o nome uma vez, no primeiro login (o frontend
    // reenvia-o em `name`); nos logins seguintes só vem o `sub` e o email.
    const user = await findOrCreateSocialUser({
      provider: 'apple',
      providerId: payload.sub,
      email: payload.email,
      name: appleName
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Apple login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[AppleLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Apple.');
  }
};

// Janela de tolerância: um token revogado há pouco tempo ainda é aceite,
// desde que sigamos a cadeia até ao token atualmente válido. Isto resolve
// pedidos de refresh concorrentes (duas abas, ou polling em segundo plano
// a coincidir com o carregamento de outra página) que de outra forma
// deslogavam o utilizador por perderem a corrida da rotação.
const REFRESH_GRACE_MS = 15 * 1000;

const _resolveCurrentToken = async (record) => {
  let current = record;
  while (current?.revoked && current.replacedByToken) {
    current = await prisma.refreshToken.findUnique({ where: { token: current.replacedByToken } });
  }
  return current;
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────
const refresh = async (req, res) => {
  // O cookie é a via preferida (não acessível a scripts), mas o Safari
  // do iOS bloqueia-o por ser "de terceiro" (frontend e backend em
  // domínios diferentes) — por isso aceitamos também o token vindo no
  // corpo do pedido, que o frontend guarda como reforço nesse caso.
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) return unauthorized(res, 'Refresh token não fornecido.');

  try {
    const record = await prisma.refreshToken.findUnique({ where: { token } });
    if (!record) return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');

    if (record.revoked) {
      const withinGrace = record.revokedAt && (Date.now() - record.revokedAt.getTime()) < REFRESH_GRACE_MS;
      const current = withinGrace ? await _resolveCurrentToken(record) : null;

      if (!current || current.revoked || new Date() > current.expiresAt) {
        return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
      }

      // Requisição concorrente que perdeu a corrida de rotação, mas dentro
      // da janela de tolerância — devolve um access token novo para o
      // token que já venceu a corrida, sem rodar de novo.
      const user = await prisma.user.findUnique({ where: { id: current.userId } });
      if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

      setRefreshCookie(res, current.token);
      return ok(res, { accessToken: signAccess(user), refreshToken: current.token }, 'Token renovado.');
    }

    if (new Date() > record.expiresAt) {
      return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
    }

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

    // Rotate refresh token
    const newRefreshToken = await createRefreshToken(user.id, req);
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true, revokedAt: new Date(), replacedByToken: newRefreshToken }
    });
    setRefreshCookie(res, newRefreshToken);

    const accessToken = signAccess(user);
    return ok(res, { accessToken, refreshToken: newRefreshToken }, 'Token renovado.');
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
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
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

// ─── VERIFY EMAIL ─────────────────────────────────────────────────
// A conta fica "verified: true" logo no registo, mas o frontend mantém
// o ecrã de verificação (ex: para reforçar confiança / uso futuro), por
// isso estes endpoints ficam disponíveis e funcionais.
const verifyEmail = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return badRequest(res, 'Email e código são obrigatórios.');

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');
    if (user.verified) return ok(res, {}, 'Email já verificado.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || record.code !== code) return badRequest(res, 'Código inválido.');
    if (new Date() > record.expiresAt) return badRequest(res, 'Código expirado.');

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { verified: true, emailVerifiedAt: new Date() } }),
      prisma.verificationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } })
    ]);

    logger.info(`[Auth] Email verified: ${user.email}`);
    return ok(res, {}, 'Email verificado com sucesso.');
  } catch (err) {
    logger.error(`[VerifyEmail] ${err.message}`);
    return serverError(res);
  }
};

// ─── RESEND VERIFICATION ──────────────────────────────────────────
const resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return badRequest(res, 'Email obrigatório.');

  // Mesma mensagem sempre, para não revelar se o email existe.
  const msg = 'Se o email existir e não estiver verificado, receberá um novo código.';

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.verified) return ok(res, {}, msg);

    await prisma.verificationCode.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() }
    });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, purpose: 'EMAIL_VERIFY', expiresAt: expiresAt(15) }
    });

    emailSvc.sendVerificationEmail(user.email, user.name, code).catch(() => {});
    logger.info(`[Auth] Verification code resent: ${user.email}`);
    return ok(res, {}, msg);
  } catch (err) {
    logger.error(`[ResendVerification] ${err.message}`);
    return ok(res, {}, msg);
  }
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
        onboardedAt: true,
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
  register,
  login, refresh, logout, logoutAll,
  forgotPassword, resetPassword, me,
  verifyEmail, resendVerification,
  googleLogin, facebookLogin, appleLogin
};


'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');


const { ok, created, badRequest, unauthorized, conflict, serverError, validationError } = require('../utils/response');
const { genCode, genToken, expiresAt } = require('../utils/helpers');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');
// NOTE: emailSvc e genCode/expiresAt continuam a ser usados em
// forgotPassword/resetPassword (recuperação de password). A verificação
// de email no REGISTO foi removida — a conta fica "verified: true" logo.

const prisma = require('../config/database');

const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

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

      // Reclama o convite de forma atómica: só marca como usado se ainda
      // estiver por usar neste preciso momento. Duas tentativas de registo
      // concorrentes com o mesmo código (ex: link partilhado, duplo clique)
      // só deixam UMA passar — a pré-verificação acima é só para dar um
      // erro rápido e amigável, esta é a garantia real contra reutilização.
      const claim = await prisma.revendedorInvite.updateMany({
        where: { id: invite.id, used: false },
        data: { used: true, usedAt: new Date() }
      });
      if (claim.count === 0) return badRequest(res, 'Código de convite inválido ou já utilizado.');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    // Create user — já fica verificado, sem fluxo de verificação por email
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role: role.toUpperCase(),
        inviteId,
        revendedorId,
        verified: true,
        emailVerifiedAt: new Date()
      }
    });

    // Log registration
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'REGISTER', entity: 'User', ipAddress: req.ip }
    });

    logger.info(`[Auth] New user registered: ${user.email} (${user.role})`);

    return created(res, {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, verified: true }
    }, 'Conta criada com sucesso. Faça login para continuar.');
  } catch (err) {
    logger.error(`[Register] ${err.message}`);
    return serverError(res, err.message);
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
      refreshToken,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, phone: user.phone, location: user.location,
        avatarUrl: user.avatarUrl, verifiedSeller: user.verifiedSeller,
        rating: user.rating, ratingCount: user.ratingCount, onboardedAt: user.onboardedAt
      }
    }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[Login] ${err.message}`);
    return serverError(res);
  }
};

// ─── LOGIN SOCIAL (Google / Facebook / Apple) ─────────────────────
// Todos os três seguem o mesmo padrão: o frontend obtém um token do SDK
// da plataforma (Google Identity Services / Facebook SDK / Apple JS),
// envia-o para aqui, nós validamos esse token directamente junto do
// provider (nunca confiamos em dados vindos do cliente sem verificar),
// e depois criamos/associamos a conta local e emitimos os NOSSOS
// próprios tokens (accessToken + refreshToken), exactamente como no
// login normal — assim o resto da app nem sabe que a origem foi social.

const buildUserResponse = (user) => ({
  id: user.id, name: user.name, email: user.email,
  role: user.role, phone: user.phone, location: user.location,
  avatarUrl: user.avatarUrl, verifiedSeller: user.verifiedSeller,
  rating: user.rating, ratingCount: user.ratingCount, onboardedAt: user.onboardedAt
});

const issueSessionFor = async (user, req, res) => {
  const accessToken = signAccess(user);
  const refreshToken = await createRefreshToken(user.id, req);
  setRefreshCookie(res, refreshToken);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { accessToken, refreshToken };
};

// Encontra o utilizador pela ligação social já existente; se não houver,
// tenta associar por email (ex: já tinha conta normal com o mesmo email);
// caso contrário cria uma conta nova, já verificada e sem password.
const findOrCreateSocialUser = async ({ provider, providerId, email, name, avatarUrl }) => {
  let user = await prisma.user.findFirst({ where: { provider, providerId } });
  if (user) return user;

  if (email) {
    user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user) {
      return prisma.user.update({
        where: { id: user.id },
        data: {
          provider: user.provider || provider,
          providerId: user.providerId || providerId,
          avatarUrl: user.avatarUrl || avatarUrl || null
        }
      });
    }
  }

  return prisma.user.create({
    data: {
      name: (name || 'Utilizador Bazares').trim(),
      email: email
        ? email.toLowerCase().trim()
        : `${provider}_${providerId}@social.bazares.local`,
      passwordHash: null,
      provider,
      providerId,
      avatarUrl: avatarUrl || null,
      role: 'BUYER',
      verified: true,
      emailVerifiedAt: new Date()
    }
  });
};

// ─── GOOGLE LOGIN ──────────────────────────────────────────────────
// Recebe o "credential" (ID token JWT) do Google Identity Services.
const googleLogin = async (req, res) => {
  if (!googleClient) return serverError(res, 'Login com Google ainda não configurado no servidor.');

  const { idToken } = req.body;
  if (!idToken) return badRequest(res, 'Token do Google em falta.');

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) return unauthorized(res, 'Token do Google inválido.');

    const user = await findOrCreateSocialUser({
      provider: 'google',
      providerId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Google login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[GoogleLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Google.');
  }
};

// ─── FACEBOOK LOGIN ─────────────────────────────────────────────────
// Recebe o accessToken devolvido pelo Facebook SDK (FB.login) e valida-o
// junto da Graph API, com appsecret_proof para reforçar a segurança.
const facebookLogin = async (req, res) => {
  if (!process.env.FACEBOOK_APP_SECRET) return serverError(res, 'Login com Facebook ainda não configurado no servidor.');

  const { accessToken: fbToken } = req.body;
  if (!fbToken) return badRequest(res, 'Token do Facebook em falta.');

  try {
    const proof = crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(fbToken).digest('hex');
    const url = `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(fbToken)}&appsecret_proof=${proof}`;
    const fbRes = await fetch(url);
    const fbData = await fbRes.json();
    if (!fbData?.id) return unauthorized(res, 'Token do Facebook inválido.');

    const user = await findOrCreateSocialUser({
      provider: 'facebook',
      providerId: fbData.id,
      email: fbData.email,
      name: fbData.name,
      avatarUrl: fbData.picture?.data?.url
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Facebook login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[FacebookLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Facebook.');
  }
};

// ─── APPLE LOGIN ────────────────────────────────────────────────────
// Pronto a usar assim que tiveres a Apple Developer Program: recebe o
// identityToken (JWT) devolvido pelo "Sign in with Apple JS". Valida a
// assinatura contra as chaves públicas da Apple (JWKS), sem precisar de
// nenhuma lib extra além do próprio jsonwebtoken + jwks-rsa.
// Falta por configurar: APPLE_CLIENT_ID (o teu Service ID) no .env.
let appleJwks = null;
const getApplePublicKey = async (kid) => {
  if (!appleJwks) {
    const res = await fetch('https://appleid.apple.com/auth/keys');
    appleJwks = (await res.json()).keys;
  }
  const key = appleJwks.find((k) => k.kid === kid);
  if (!key) { appleJwks = null; throw new Error('Chave Apple não encontrada.'); }
  return crypto.createPublicKey({ key, format: 'jwk' });
};

const appleLogin = async (req, res) => {
  if (!process.env.APPLE_CLIENT_ID) return serverError(res, 'Login com Apple ainda não configurado no servidor (falta Apple Developer Program).');

  const { identityToken, name: appleName } = req.body;
  if (!identityToken) return badRequest(res, 'Token da Apple em falta.');

  try {
    const decodedHeader = jwt.decode(identityToken, { complete: true });
    if (!decodedHeader?.header?.kid) return unauthorized(res, 'Token da Apple inválido.');

    const publicKey = await getApplePublicKey(decodedHeader.header.kid);
    const payload = jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      audience: process.env.APPLE_CLIENT_ID,
      issuer: 'https://appleid.apple.com'
    });
    if (!payload?.sub) return unauthorized(res, 'Token da Apple inválido.');

    // A Apple só envia o nome uma vez, no primeiro login (o frontend
    // reenvia-o em `name`); nos logins seguintes só vem o `sub` e o email.
    const user = await findOrCreateSocialUser({
      provider: 'apple',
      providerId: payload.sub,
      email: payload.email,
      name: appleName
    });
    if (!user.active) return unauthorized(res, 'Conta suspensa. Contacte o suporte em bazares09@gmail.com');

    const { accessToken, refreshToken } = await issueSessionFor(user, req, res);
    logger.info(`[Auth] Apple login: ${user.email}`);
    return ok(res, { accessToken, refreshToken, user: buildUserResponse(user) }, 'Login efectuado com sucesso.');
  } catch (err) {
    logger.error(`[AppleLogin] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação com Apple.');
  }
};

// Janela de tolerância: um token revogado há pouco tempo ainda é aceite,
// desde que sigamos a cadeia até ao token atualmente válido. Isto resolve
// pedidos de refresh concorrentes (duas abas, ou polling em segundo plano
// a coincidir com o carregamento de outra página) que de outra forma
// deslogavam o utilizador por perderem a corrida da rotação.
const REFRESH_GRACE_MS = 15 * 1000;

const _resolveCurrentToken = async (record) => {
  let current = record;
  while (current?.revoked && current.replacedByToken) {
    current = await prisma.refreshToken.findUnique({ where: { token: current.replacedByToken } });
  }
  return current;
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────
const refresh = async (req, res) => {
  // O cookie é a via preferida (não acessível a scripts), mas o Safari
  // do iOS bloqueia-o por ser "de terceiro" (frontend e backend em
  // domínios diferentes) — por isso aceitamos também o token vindo no
  // corpo do pedido, que o frontend guarda como reforço nesse caso.
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) return unauthorized(res, 'Refresh token não fornecido.');

  try {
    const record = await prisma.refreshToken.findUnique({ where: { token } });
    if (!record) return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');

    if (record.revoked) {
      const withinGrace = record.revokedAt && (Date.now() - record.revokedAt.getTime()) < REFRESH_GRACE_MS;
      const current = withinGrace ? await _resolveCurrentToken(record) : null;

      if (!current || current.revoked || new Date() > current.expiresAt) {
        return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
      }

      // Requisição concorrente que perdeu a corrida de rotação, mas dentro
      // da janela de tolerância — devolve um access token novo para o
      // token que já venceu a corrida, sem rodar de novo.
      const user = await prisma.user.findUnique({ where: { id: current.userId } });
      if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

      setRefreshCookie(res, current.token);
      return ok(res, { accessToken: signAccess(user), refreshToken: current.token }, 'Token renovado.');
    }

    if (new Date() > record.expiresAt) {
      return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
    }

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

    // Rotate refresh token
    const newRefreshToken = await createRefreshToken(user.id, req);
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true, revokedAt: new Date(), replacedByToken: newRefreshToken }
    });
    setRefreshCookie(res, newRefreshToken);

    const accessToken = signAccess(user);
    return ok(res, { accessToken, refreshToken: newRefreshToken }, 'Token renovado.');
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
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
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

// ─── VERIFY EMAIL ─────────────────────────────────────────────────
// A conta fica "verified: true" logo no registo, mas o frontend mantém
// o ecrã de verificação (ex: para reforçar confiança / uso futuro), por
// isso estes endpoints ficam disponíveis e funcionais.
const verifyEmail = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return badRequest(res, 'Email e código são obrigatórios.');

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return badRequest(res, 'Utilizador não encontrado.');
    if (user.verified) return ok(res, {}, 'Email já verificado.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || record.code !== code) return badRequest(res, 'Código inválido.');
    if (new Date() > record.expiresAt) return badRequest(res, 'Código expirado.');

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { verified: true, emailVerifiedAt: new Date() } }),
      prisma.verificationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } })
    ]);

    logger.info(`[Auth] Email verified: ${user.email}`);
    return ok(res, {}, 'Email verificado com sucesso.');
  } catch (err) {
    logger.error(`[VerifyEmail] ${err.message}`);
    return serverError(res);
  }
};

// ─── RESEND VERIFICATION ──────────────────────────────────────────
const resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return badRequest(res, 'Email obrigatório.');

  // Mesma mensagem sempre, para não revelar se o email existe.
  const msg = 'Se o email existir e não estiver verificado, receberá um novo código.';

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.verified) return ok(res, {}, msg);

    await prisma.verificationCode.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() }
    });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, purpose: 'EMAIL_VERIFY', expiresAt: expiresAt(15) }
    });

    emailSvc.sendVerificationEmail(user.email, user.name, code).catch(() => {});
    logger.info(`[Auth] Verification code resent: ${user.email}`);
    return ok(res, {}, msg);
  } catch (err) {
    logger.error(`[ResendVerification] ${err.message}`);
    return ok(res, {}, msg);
  }
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
        onboardedAt: true,
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
  register,
  login, refresh, logout, logoutAll,
  forgotPassword, resetPassword, me,
  verifyEmail, resendVerification,
  googleLogin, facebookLogin, appleLogin
};



