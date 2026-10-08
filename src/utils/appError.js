'use strict';

/**
 * Erro de regra de negócio com código estável — o `handle()` converte-o na resposta HTTP no formato
 * padrão do projecto (success:false, message, error:{code,message}, requestId).
 * Nunca incluir dados sensíveis na mensagem: ela vai para o cliente.
 */
class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extra = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (message, code = 'BAD_REQUEST', extra) => new AppError(message, 400, code, extra);
const notFoundErr = (message = 'Recurso não encontrado.', code = 'NOT_FOUND') => new AppError(message, 404, code);
const forbiddenErr = (message = 'Acesso negado.', code = 'FORBIDDEN') => new AppError(message, 403, code);
const conflictErr = (message = 'Conflito de dados.', code = 'CONFLICT', extra) => new AppError(message, 409, code, extra);

/**
 * Se `err` é um erro de negócio conhecido, escreve a resposta HTTP e devolve true (senão false).
 * Reutilizado pelo `handle()` e por controllers antigos com try/catch próprio (ex.: placeOrder).
 */
const replyKnown = (res, err) => {
  const { errorBody } = require('./response');
  if (err && (err.name === 'AppError' || err.name === 'WalletFlowError')) {
    res.status(err.status || 400).json(errorBody(res, err.code || 'BAD_REQUEST', err.message, err.extra ? { details: err.extra } : {}));
    return true;
  }
  if (err && err.name === 'InsufficientFundsError') {
    res.status(400).json(errorBody(res, 'INSUFFICIENT_FUNDS', err.message));
    return true;
  }
  return false;
};

/**
 * Envolve um handler Express: erros conhecidos viram respostas limpas; o resto é 500 genérico
 * (o detalhe fica só no log — nunca em err.message para o cliente).
 */
const handle = (label, fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    // require lazy: o módulo continua testável sem BD/logger configurados
    const { errorBody, serverError } = require('./response');
    const logger = require('./logger');
    if (replyKnown(res, err)) return;
    if (err && err.code === 'P2002') {
      return res.status(409).json(errorBody(res, 'CONFLICT', 'Este registo já existe.'));
    }
    if (err && err.code === 'P2025') {
      return res.status(404).json(errorBody(res, 'NOT_FOUND', 'Recurso não encontrado.'));
    }
    if (err && err.code === 'P2021') {
      // Tabela inexistente = migração Fase 5 ainda não aplicada. Mensagem clara no log, genérica para o cliente.
      logger.error(`[${label}] tabela em falta — aplique "prisma migrate deploy": ${err.message}`);
      return serverError(res, 'Funcionalidade temporariamente indisponível.');
    }
    logger.error(`[${label}] ${err && err.message}`);
    return serverError(res);
  }
};

module.exports = { AppError, bad, notFoundErr, forbiddenErr, conflictErr, handle, replyKnown };
