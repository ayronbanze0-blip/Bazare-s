'use strict';

const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../utils/response');
const logger = require('../utils/logger');
const Sentry = require('../config/sentry');
const prisma = require('../config/database');
const { createTtlCache } = require('../utils/ttlCache');

// Liga o utilizador autenticado ao evento/transacção Sentry corrente —
// sem isto, todo erro no backend aparece como "utilizador desconhecido"
// e não dá para ver quantas PESSOAS diferentes são afectadas pelo
// mesmo problema (só quantas vezes aconteceu).
function tagSentryUser(req) {
  try {
    if (req.user?.id) Sentry.setUser({ id: req.user.id, role: req.user.role });
  } catch {}
}

// ─── Verify Access Token ─────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized(res, 'Token de acesso não fornecido.');
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') return unauthorized(res, 'Sessão expirada. Faça login novamente.');
      return unauthorized(res, 'Token inválido.');
    }

    // Verifica o estado ACTUAL da conta na BD, em vez de confiar cegamente
    // no que o access token diz. Sem isto: (1) um admin suspende um
    // utilizador mas o access token continua válido por até ~15 minutos —
    // a conta suspensa continuava a poder usar a API; (2) depois do
    // onboarding BUYER→SELLER, o token antigo continuava com role=BUYER
    // até expirar, e endpoints que exigem SELLER devolviam 403 mesmo
    // depois do onboarding ter sido concluído com sucesso. Isto adiciona
    // uma leitura à BD por pedido autenticado — aceitável dado o ganho de
    // segurança/correcção; se o custo se tornar um problema, cachear
    // `active`+`role` por poucos segundos por userId é a próxima opção.
    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { active: true, role: true }
    });
    if (!dbUser || !dbUser.active) {
      return unauthorized(res, 'Esta conta está suspensa ou já não existe.');
    }

    // Usa sempre o role actual da BD para decisões de autorização, nunca
    // o que veio dentro do token (pode estar desactualizado).
    req.user = { ...decoded, role: dbUser.role };
    tagSentryUser(req);
    next();
  } catch (err) {
    logger.error(`[Auth Middleware] ${err.message}`);
    return unauthorized(res, 'Falha na autenticação.');
  }
};

// ─── Role Guard ──────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return unauthorized(res);
  if (!roles.includes(req.user.role)) {
    return forbidden(res, `Acesso restrito a: ${roles.join(', ')}`);
  }
  next();
};

const isAdmin = requireRole('ADMIN');
const isRevendedor = requireRole('ADMIN', 'REVENDEDOR');
// CONTA ÚNICA: qualquer conta autenticada (e activa) pode comprar E vender, sem
// passo de "ser vendedor" nem aprovação. Estes dois guards ficam como nomes
// estáveis (as rotas já os usam) mas aceitam todos os papéis; o papel só decide
// o que é administração (ADMIN) e revenda (REVENDEDOR). A única regra de
// integridade que se mantém é não comprar os próprios produtos
// (cartController.addItem + checkoutService).
const ANY_ACCOUNT = ['ADMIN', 'SELLER', 'BUYER', 'REVENDEDOR'];
const isSeller = requireRole(...ANY_ACCOUNT);
const isBuyer = requireRole(...ANY_ACCOUNT);
const isAuthenticated = authenticate;

// ─── Optional Auth (public routes that enhance if logged in) ─────
// Também confirma o estado ACTUAL da conta (como o `authenticate`), com uma cache curta (15 s) para
// não pesar na BD em rotas públicas: uma conta suspensa deixa de ser tratada como autenticada e o
// papel vem da BD, não de um token antigo (ex.: ex-admin com token ainda válido).
const accountCache = createTtlCache({ ttlMs: 15 * 1000, max: 2000 });
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) { req.user = null; return next(); }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    const acct = await accountCache.wrap(decoded.id, () =>
      prisma.user.findUnique({ where: { id: decoded.id }, select: { active: true, role: true } }));
    req.user = acct && acct.active ? { ...decoded, role: acct.role } : null;
    if (req.user) tagSentryUser(req);
  } catch { req.user = null; }
  next();
};

// ─── Ownership Guard ─────────────────────────────────────────────
const ownOrAdmin = (getOwnerId) => async (req, res, next) => {
  try {
    if (req.user.role === 'ADMIN') return next();
    const ownerId = await getOwnerId(req);
    if (ownerId !== req.user.id) return forbidden(res, 'Não tem permissão para esta acção.');
    next();
  } catch (err) {
    logger.error(`[ownOrAdmin] ${err.message}`);
    return forbidden(res);
  }
};

module.exports = {
  authenticate,
  requireRole,
  isAdmin,
  isSeller,
  isRevendedor,
  isBuyer,
  isAuthenticated,
  optionalAuth,
  ownOrAdmin
};
