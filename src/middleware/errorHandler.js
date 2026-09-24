'use strict';

const Sentry = require('../config/sentry');
const logger = require('../utils/logger');
const { notFound, errorBody } = require('../utils/response');
const { redact } = require('../utils/redact');

// ─── 404 Handler ────────────────────────────────────────────────
const notFoundHandler = (req, res) => {
  notFound(res, `Rota não encontrada: ${req.method} ${req.originalUrl}`);
};

// ─── Global Error Handler ────────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  // Resposta já a meio (streaming) — o Express tem de fechar a ligação.
  if (res.headersSent) return next(err);

  // Detalhes completos (stack incluída) ficam SÓ nos logs internos — nunca na
  // resposta. `redact` é uma rede de segurança caso algum dia se acrescente
  // contexto extra que possa conter credenciais.
  logger.error(`[Error] ${err.message}`, redact({
    requestId: req.id,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userId: req.user?.id
  }));

  const send = (status, code, message, extra) =>
    res.status(status).json(errorBody({ req }, code, message, extra));

  // CORS rejection
  if (err.message === 'Não autorizado pela política de CORS.') {
    return send(403, 'CORS_FORBIDDEN', err.message);
  }

  // Corpo JSON malformado / demasiado grande — erros do CLIENTE (4xx), não
  // do servidor: antes caíam no 500 genérico e enchiam o Sentry de ruído.
  if (err.type === 'entity.parse.failed') return send(400, 'INVALID_JSON', 'Corpo do pedido inválido (JSON malformado).');
  if (err.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'Pedido demasiado grande.');

  // Multer errors
  // O limite real depende de qual multer apanhou o ficheiro (imagem
  // 10MB, vídeo 60MB, vídeo bruto do editor 150MB) — usar sempre
  // "10MB" na mensagem era enganador para uploads de vídeo/histórias
  // que na verdade tinham limites bem maiores.
  if (err.code === 'LIMIT_FILE_SIZE') {
    const isVideoRoute = /\/(reels|stories|media\/video)/.test(req.originalUrl || '');
    const isEditRoute = /\/media\/video\/(process|edit)/.test(req.originalUrl || '');
    const max = isEditRoute ? '150MB' : isVideoRoute ? '60MB' : '10MB';
    return send(400, 'FILE_TOO_LARGE', `Ficheiro demasiado grande. Máximo: ${max}.`);
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return send(400, 'TOO_MANY_FILES', 'Demasiados ficheiros para este envio.');
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return send(400, 'UNEXPECTED_FILE', 'Campo de ficheiro inesperado.');
  }
  if (err.message?.includes('Apenas imagens') || err.message?.includes('Apenas vídeos') || err.message?.includes('Apenas áudio')) {
    return send(400, 'INVALID_FILE_TYPE', err.message);
  }

  // Prisma errors
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] || 'campo';
    return send(409, 'CONFLICT', `${field} já existe.`);
  }
  if (err.code === 'P2025') {
    return send(404, 'NOT_FOUND', 'Registo não encontrado.');
  }
  if (err.code === 'P2003') {
    return send(400, 'INVALID_REFERENCE', 'Referência inválida.');
  }
  // P2024: esgotou o pool de ligações à base de dados (muitos pedidos em
  // simultâneo). Sem isto, o cliente veria um "Erro interno do servidor"
  // genérico em vez de perceber que é só um pico de carga transitório.
  if (err.code === 'P2024' || /timed out fetching a new connection/i.test(err.message || '')) {
    return send(503, 'SERVICE_BUSY', 'Servidor com muitos pedidos em simultâneo. Tenta novamente em alguns segundos.');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return send(401, 'UNAUTHORIZED', 'Token inválido.');
  }
  if (err.name === 'TokenExpiredError') {
    return send(401, 'UNAUTHORIZED', 'Sessão expirada.');
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return send(422, 'VALIDATION_ERROR', err.message);
  }

  // Default 500 — chegar aqui significa que nenhum dos casos conhecidos
  // acima tratou o erro, ou seja, é inesperado. Só estes vão para o
  // Sentry (os 4xx já tratados acima são esperados e não gastam quota).
  Sentry.captureException(err, {
    tags: {
      requestId: req.id,
      route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.originalUrl?.split('?')[0],
      method: req.method,
      role: req.user?.role
    },
    extra: { requestId: req.id, method: req.method },
    user: req.user?.id ? { id: req.user.id } : undefined
  });

  // Em produção NUNCA se devolve err.message (pode conter SQL, caminhos, nomes de colunas…).
  const msg = process.env.NODE_ENV === 'production'
    ? 'Erro interno do servidor.'
    : err.message;
  return send(500, 'INTERNAL_ERROR', msg);
};

module.exports = { notFoundHandler, errorHandler };
