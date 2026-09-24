'use strict';

/**
 * Standardized API response helpers
 */

const ok = (res, data = {}, message = 'Sucesso', statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

const created = (res, data = {}, message = 'Criado com sucesso') =>
  res.status(201).json({ success: true, message, data });

const accepted = (res, data = {}, message = 'Pedido aceite') =>
  res.status(202).json({ success: true, message, data });

const noContent = (res) => res.status(204).send();

// ─── Respostas de erro ────────────────────────────────────────────
// Formato consistente e ADITIVO (backward compatible): mantém `success:false`
// e `message` no topo (é o que o frontend lê hoje) e acrescenta
//   error: { code, message }   → código estável para o cliente/máquinas
//   requestId                  → o mesmo ID do header X-Request-Id e dos logs
// Nunca inclui stack traces, SQL, caminhos internos ou segredos.
const errorBody = (res, code, message, extra = {}) => {
  const requestId = res && res.req && res.req.id;
  return {
    success: false,
    message,
    error: { code, message },
    ...(requestId && { requestId }),
    ...extra
  };
};

const badRequest = (res, message = 'Pedido inválido', errors = null) =>
  res.status(400).json(errorBody(res, 'BAD_REQUEST', message, errors ? { errors } : {}));

const unauthorized = (res, message = 'Não autorizado') =>
  res.status(401).json(errorBody(res, 'UNAUTHORIZED', message));

const forbidden = (res, message = 'Acesso negado') =>
  res.status(403).json(errorBody(res, 'FORBIDDEN', message));

const notFound = (res, message = 'Recurso não encontrado') =>
  res.status(404).json(errorBody(res, 'NOT_FOUND', message));

const conflict = (res, message = 'Conflito de dados') =>
  res.status(409).json(errorBody(res, 'CONFLICT', message));

const tooMany = (res, message = 'Demasiadas tentativas. Tente mais tarde.') =>
  res.status(429).json(errorBody(res, 'RATE_LIMITED', message));

// `message` só deve ser uma frase AMIGÁVEL escrita à mão — nunca `err.message`.
const serverError = (res, message = 'Erro interno do servidor') =>
  res.status(500).json(errorBody(res, 'INTERNAL_ERROR', message));

const validationError = (res, errors) =>
  res.status(422).json(errorBody(res, 'VALIDATION_ERROR', 'Erro de validação', {
    errors: errors.map(e => ({ field: e.path, message: e.msg }))
  }));

module.exports = { errorBody, ok, created, accepted, noContent, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, serverError, validationError };
