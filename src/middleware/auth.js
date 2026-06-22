'use strict';

const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../utils/response');
const logger = require('../utils/logger');

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
      decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return unauthorized(res, 'Sessão expirada. Faça login novamente.');
      return unauthorized(res, 'Token inválido.');
    }

    // Attach user payload to request
    req.user = decoded;
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
const isSeller = requireRole('ADMIN', 'SELLER');
const isRevendedor = requireRole('ADMIN', 'REVENDEDOR');
const isBuyer = requireRole('BUYER');
const isAuthenticated = authenticate;

// ─── Optional Auth (public routes that enhance if logged in) ─────
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_ACCESS_SECRET);
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
