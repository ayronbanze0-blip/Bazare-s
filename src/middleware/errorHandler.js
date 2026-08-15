'use strict';

const Sentry = require('../config/sentry');
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
  // O limite real depende de qual multer apanhou o ficheiro (imagem
  // 10MB, vídeo 60MB, vídeo bruto do editor 150MB) — usar sempre
  // "10MB" na mensagem era enganador para uploads de vídeo/histórias
  // que na verdade tinham limites bem maiores.
  if (err.code === 'LIMIT_FILE_SIZE') {
    const isVideoRoute = /\/(reels|stories|media\/video)/.test(req.originalUrl || '');
    const isEditRoute = /\/media\/video\/(process|edit)/.test(req.originalUrl || '');
    const max = isEditRoute ? '150MB' : isVideoRoute ? '60MB' : '10MB';
    return res.status(400).json({ success: false, message: `Ficheiro demasiado grande. Máximo: ${max}.` });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ success: false, message: 'Demasiados ficheiros para este envio.' });
  }
  if (err.message?.includes('Apenas imagens') || err.message?.includes('Apenas vídeos') || err.message?.includes('Apenas áudio')) {
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

  // Default 500 — chegar aqui significa que nenhum dos casos conhecidos
  // acima tratou o erro, ou seja, é inesperado. Só estes vão para o
  // Sentry (os 4xx já tratados acima são esperados e não gastam quota).
  Sentry.captureException(err, {
    extra: { requestId: req.id, url: req.originalUrl, method: req.method },
    user: req.user?.id ? { id: req.user.id } : undefined
  });

  const msg = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor.'
    : err.message;
  return res.status(500).json({ success: false, message: msg, requestId: req.id });
};

module.exports = { notFoundHandler, errorHandler };
