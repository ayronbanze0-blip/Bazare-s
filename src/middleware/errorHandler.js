'use strict';

const logger = require('../utils/logger');
const { notFound } = require('../utils/response');

// ─── 404 Handler ────────────────────────────────────────────────
const notFoundHandler = (req, res) => {
  notFound(res, `Rota não encontrada: ${req.method} ${req.originalUrl}`);
};

// ─── Global Error Handler ────────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  logger.error(`[Error] ${err.message}`, {
    requestId: req.id,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userId: req.user?.id
  });

  // CORS rejection
  if (err.message === 'Não autorizado pela política de CORS.') {
    return res.status(403).json({ success: false, message: err.message });
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Ficheiro demasiado grande. Máximo: 10MB.' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ success: false, message: 'Demasiados ficheiros. Máximo: 20.' });
  }
  if (err.message?.includes('Apenas imagens')) {
    return res.status(400).json({ success: false, message: err.message });
  }

  // Prisma errors
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] || 'campo';
    return res.status(409).json({ success: false, message: `${field} já existe.` });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Registo não encontrado.' });
  }
  if (err.code === 'P2003') {
    return res.status(400).json({ success: false, message: 'Referência inválida.' });
  }
  // P2024: esgotou o pool de ligações à base de dados (muitos pedidos em
  // simultâneo). Sem isto, o cliente veria um "Erro interno do servidor"
  // genérico em vez de perceber que é só um pico de carga transitório.
  if (err.code === 'P2024' || /timed out fetching a new connection/i.test(err.message || '')) {
    return res.status(503).json({
      success: false,
      message: 'Servidor com muitos pedidos em simultâneo. Tenta novamente em alguns segundos.',
      requestId: req.id
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Token inválido.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Sessão expirada.' });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(422).json({ success: false, message: err.message });
  }

  // Default 500
  const msg = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor.'
    : err.message;
  return res.status(500).json({ success: false, message: msg, requestId: req.id });
};

module.exports = { notFoundHandler, errorHandler };
