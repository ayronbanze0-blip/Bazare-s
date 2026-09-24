'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');


const { ok, created, badRequest, unauthorized, conflict, serverError, validationError } = require('../utils/response');
const { genCode, genToken, expiresAt, hashCode, codeMatches } = require('../utils/helpers');
const { uniqueUsername } = require('../utils/slugify');
const emailSvc = require('../services/emailService');
const logger = require('../utils/logger');
const audit = require('../services/auditService');
const { sanitize } = require('../utils/helpers');
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

class InviteClaimError extends Error {
  constructor() { super('invite_claimed'); this.name = 'InviteClaimError'; }
}

// Hash "de mentira" para comparar quando o email não existe (ou a conta não
// tem password, ex.: login social) — assim o tempo de resposta não revela se
// o email está registado (ataque de enumeração por timing).
let _dummyHash = null;
const dummyCompare = async (password) => {
  if (!_dummyHash) _dummyHash = await bcrypt.hash('bazares-dummy-password', parseInt(process.env.BCRYPT_ROUNDS) || 12);
  await bcrypt.compare(String(password || ''), _dummyHash);
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

    // Handle revendedor invite (validação rápida — a reclamação atómica acontece
    // dentro da transacção abaixo, em conjunto com a criação do utilizador)
    let inviteId = null;
    let revendedorId = null;
    if (role === 'REVENDEDOR') {
      if (!inviteCode) return badRequest(res, 'Código de convite obrigatório para revendedores.');
      const invite = await prisma.revendedorInvite.findUnique({ where: { token: inviteCode } });
      if (!invite || invite.used) return badRequest(res, 'Código de convite inválido ou já utilizado.');
      if (invite.expiresAt && new Date() > invite.expiresAt) return badRequest(res, 'Código de convite expirado.');
      inviteId = invite.id;
      revendedorId = invite.createdById;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    // Alcunha única para o sistema de menções ("@joaomatavel") —
    // gerada automaticamente a partir do nome, sem pedir nada extra
    // no formulário de registo.
    const cleanName = sanitize(name);
    const username = await uniqueUsername(cleanName, async (candidate) => {
      const found = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
      return !!found;
    });

    // Reclamar o convite E criar o utilizador na MESMA transacção: antes, o
    // convite era marcado como usado primeiro e, se a criação do utilizador
    // falhasse a seguir (ex.: email duplicado concorrente), o convite ficava
    // queimado sem ninguém o ter usado. O updateMany condicional continua a
    // garantir que só UM registo concorrente consegue usar o mesmo código.
    const user = await prisma.$transaction(async (tx) => {
      if (inviteId) {
        const claim = await tx.revendedorInvite.updateMany({
          where: { id: inviteId, used: false },
          data: { used: true, usedAt: new Date() }
        });
        if (claim.count === 0) throw new InviteClaimError();
      }
      // Já fica verificado, sem fluxo de verificação por email
      return tx.user.create({
        data: {
          name: cleanName,
          email: email.toLowerCase().trim(),
          passwordHash,
          username,
          role: role.toUpperCase(),
          inviteId,
          revendedorId,
          verified: true,
          emailVerifiedAt: new Date()
        }
      });
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
    if (err instanceof InviteClaimError) return badRequest(res, 'Código de convite inválido ou já utilizado.');
    if (err.code === 'P2002') return conflict(res, 'Este email já está registado.');
    // Nunca devolver err.message ao cliente (podia expor mensagens do Prisma/BD).
    return serverError(res, 'Não foi possível criar a conta. Tente novamente.');
  }
};

// ─── LOGIN ────────────────────────────────────────────────────────
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { email, password } = req.body;

  try {
    // Brute-force lockout — combinado por (email + IP), não só por email.
    // Antes disto, bloquear só por email era um Account Lockout DoS: um
    // atacante que apenas conhecesse o email de alguém podia enviar 5
    // passwords erradas a partir do seu próprio IP e bloquear a VÍTIMA
    // durante 15 minutos, sem nunca saber a password dela — e repetir
    // indefinidamente. Ao exigir a mesma combinação (email + IP) para o
    // bloqueio principal, o login da vítima a partir do seu próprio
    // dispositivo/rede continua a funcionar; o atacante só se bloqueia a
    // si mesmo. Mantemos também um limite (mais alto) só por email, para
    // ainda apanhar ataques distribuídos por muitos IPs diferentes.
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const [failsThisIp, failsAnyIp] = await Promise.all([
      prisma.loginAttempt.count({
        where: { email: email.toLowerCase(), success: false, ipAddress: req.ip, createdAt: { gte: since } }
      }),
      prisma.loginAttempt.count({
        where: { email: email.toLowerCase(), success: false, createdAt: { gte: since } }
      })
    ]);
    if (failsThisIp >= 5 || failsAnyIp >= 20) {
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

    if (!user || !user.passwordHash) {
      // Sem utilizador, ou conta só de login social (sem password): mesma
      // resposta e mesmo custo que uma password errada.
      await dummyCompare(password);
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

  const username = await uniqueUsername((name || 'Utilizador Bazares').trim(), async (candidate) => {
    const found = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    return !!found;
  });

  return prisma.user.create({
    data: {
      name: (name || 'Utilizador Bazares').trim(),
      email: email
        ? email.toLowerCase().trim()
        : `${provider}_${providerId}@social.bazares.local`,
      passwordHash: null,
      username,
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
    // Só se confia no email do Google se o próprio Google o marcou como verificado —
    // caso contrário alguém podia associar-se à conta de outra pessoa pelo email.
    if (payload.email && payload.email_verified === false) {
      return unauthorized(res, 'O email da conta Google não está verificado.');
    }

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

// Revoga todos os tokens descendentes de `record` (segue replacedByToken até ao fim).
const _revokeChain = async (record) => {
  const now = new Date();
  let next = record.replacedByToken;
  let guard = 0;
  while (next && guard++ < 50) {
    const t = await prisma.refreshToken.findUnique({ where: { token: next } });
    if (!t) break;
    if (!t.revoked) await prisma.refreshToken.update({ where: { id: t.id }, data: { revoked: true, revokedAt: now } });
    next = t.replacedByToken;
  }
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
    // Antes: buscava o refreshToken e, só depois, o user numa segunda
    // ida à base de dados — 2 round-trips sequenciais no caminho mais
    // comum (token válido, não revogado). Combinado num único pedido
    // com `include`, poupa uma dessas idas em cada refresh — que é a
    // rota mais chamada de toda a app (dispara em cada carregamento de
    // página autenticada) e a mais lenta no painel de monitorização.
    const record = await prisma.refreshToken.findUnique({ where: { token }, include: { user: true } });
    if (!record) return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');

    if (record.revoked) {
      const withinGrace = record.revokedAt && (Date.now() - record.revokedAt.getTime()) < REFRESH_GRACE_MS;
      const current = withinGrace ? await _resolveCurrentToken(record) : null;

      if (!current || current.revoked || new Date() > current.expiresAt) {
        // REUTILIZAÇÃO: um token que JÁ foi rodado (tem replacedByToken) voltou a ser
        // apresentado fora da janela de tolerância. Ou é um cliente com resposta perdida,
        // ou alguém copiou o token. Em ambos os casos revoga-se TODA a cadeia descendente
        // (a sessão actual desse dispositivo) — quem roubou o token fica sem acesso e o
        // utilizador legítimo volta a autenticar-se. Tokens revogados por logout
        // (sem replacedByToken) NÃO disparam isto.
        if (record.replacedByToken && !withinGrace) {
          await _revokeChain(record);
          audit.record(req, 'AUTH_REFRESH_TOKEN_REUSE', {
            entity: 'User', entityId: record.userId, userId: record.userId,
            newValue: { tokenId: record.id }
          });
          logger.warn(`[Auth] Reutilização de refresh token detectada (user ${record.userId}) — cadeia revogada.`);
        }
        return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
      }

      // Requisição concorrente que perdeu a corrida de rotação, mas dentro
      // da janela de tolerância — devolve um access token novo para o
      // token que já venceu a corrida, sem rodar de novo. `current` pode
      // vir de `_resolveCurrentToken` sem o `user` incluído (segue a
      // cadeia de replacedByToken), por isso usa o do `record` original
      // quando é o mesmo utilizador, só voltando à BD se mudou.
      const user = current.userId === record.userId ? record.user : await prisma.user.findUnique({ where: { id: current.userId } });
      if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

      setRefreshCookie(res, current.token);
      return ok(res, { accessToken: signAccess(user), refreshToken: current.token }, 'Token renovado.');
    }

    if (new Date() > record.expiresAt) {
      return unauthorized(res, 'Refresh token inválido ou expirado. Faça login novamente.');
    }

    const user = record.user;
    if (!user || !user.active) return unauthorized(res, 'Utilizador inválido.');

    // Rotate refresh token — cria o novo e revoga o antigo numa única
    // transacção: antes eram 2 pedidos independentes, e uma falha entre
    // eles (rede, cold start da ligação) podia deixar 2 tokens activos
    // em simultâneo para o mesmo utilizador.
    const newToken = signRefresh();
    const expiresInDays = 7;
    await prisma.$transaction([
      prisma.refreshToken.create({
        data: {
          token: newToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + expiresInDays * 24 * 3600 * 1000),
          userAgent: req.headers['user-agent']?.slice(0, 255),
          ipAddress: req.ip
        }
      }),
      prisma.refreshToken.update({
        where: { id: record.id },
        data: { revoked: true, revokedAt: new Date(), replacedByToken: newToken }
      })
    ]);
    setRefreshCookie(res, newToken);

    const accessToken = signAccess(user);
    return ok(res, { accessToken, refreshToken: newToken }, 'Token renovado.');
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
      where: { token, revoked: false },
      data: { revoked: true, revokedAt: new Date() }
    }).catch(() => {});
  }
  clearRefreshCookie(res);
  return ok(res, {}, 'Sessão terminada.');
};

// ─── LOGOUT ALL (revoke all sessions) ────────────────────────────
const logoutAll = async (req, res) => {
  await prisma.refreshToken.updateMany({
    where: { userId: req.user.id, revoked: false },
    data: { revoked: true, revokedAt: new Date() }
  }).catch(() => {});
  audit.record(req, 'AUTH_LOGOUT_ALL', { entity: 'User', entityId: req.user.id });
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
    // Mesma resposta que um código errado — não revela se o email existe.
    if (!user) return badRequest(res, 'Código inválido.');
    if (user.verified) return ok(res, {}, 'Email já verificado.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || !codeMatches(code, record.code)) return badRequest(res, 'Código inválido.');
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
      // Guardamos o HASH do código, nunca o código em texto puro — o
      // valor em claro só existe no email enviado ao utilizador.
      data: { userId: user.id, code: hashCode(code), purpose: 'EMAIL_VERIFY', expiresAt: expiresAt(15) }
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
      // Guardamos o HASH do código, nunca o código em texto puro — o
      // valor em claro só existe no email enviado ao utilizador.
      data: { userId: user.id, code: hashCode(code), purpose: 'PASSWORD_RESET', expiresAt: expiresAt(15) }
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
    // Mesma resposta que um código errado — não revela se o email existe.
    if (!user) return badRequest(res, 'Código inválido.');

    const record = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || !codeMatches(code, record.code)) return badRequest(res, 'Código inválido.');
    if (new Date() > record.expiresAt) return badRequest(res, 'Código expirado.');

    const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.verificationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // Revoke all sessions for security
      prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } })
    ]);

    audit.record(req, 'AUTH_PASSWORD_RESET', { entity: 'User', entityId: user.id, userId: user.id });
    logger.info(`[Auth] Password reset: ${user.id}`);
    return ok(res, {}, 'Palavra-passe redefinida com sucesso. Faça login.');
  } catch (err) {
    logger.error(`[ResetPassword] ${err.message}`);
    return serverError(res);
  }
};

const premiumService = require('../services/premiumService');

// ─── GET CURRENT USER ─────────────────────────────────────────────
const me = async (req, res) => {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, location: true, bio: true,
        avatarUrl: true, coverUrl: true,
        verified: true, verifiedSeller: true, active: true,
        rating: true, ratingCount: true, cancelCount: true,
        revendedorId: true, createdAt: true, lastLoginAt: true,
        onboardedAt: true,
        isPremium: true, premiumSince: true, premiumExpiresAt: true,
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

    // Rebaixa aqui, no ponto mais frequentemente chamado do app (carregado
    // a cada refresh de página), em vez de depender de um cron job.
    if (user.isPremium && !premiumService.isActive(user)) {
      await premiumService.downgradeIfExpired(prisma, user);
      user.isPremium = false;
    }

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


