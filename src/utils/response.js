'use strict';

/**
 * Standardized API response helpers
 */

const ok = (res, data = {}, message = 'Sucesso', statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

const created = (res, data = {}, message = 'Criado com sucesso') =>
  res.status(201).json({ success: true, message, data });

const noContent = (res) => res.status(204).send();

const badRequest = (res, message = 'Pedido inválido', errors = null) =>
  res.status(400).json({ success: false, message, ...(errors && { errors }) });

const unauthorized = (res, message = 'Não autorizado') =>
  res.status(401).json({ success: false, message });

const forbidden = (res, message = 'Acesso negado') =>
  res.status(403).json({ success: false, message });

const notFound = (res, message = 'Recurso não encontrado') =>
  res.status(404).json({ success: false, message });

const conflict = (res, message = 'Conflito de dados') =>
  res.status(409).json({ success: false, message });

const tooMany = (res, message = 'Demasiadas tentativas. Tente mais tarde.') =>
  res.status(429).json({ success: false, message });

const serverError = (res, message = 'Erro interno do servidor') =>
  res.status(500).json({ success: false, message });

const validationError = (res, errors) =>
  res.status(422).json({
    success: false,
    message: 'Erro de validação',
    errors: errors.map(e => ({ field: e.path, message: e.msg }))
  });

module.exports = { ok, created, noContent, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, serverError, validationError };
