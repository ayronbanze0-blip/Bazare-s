'use strict';

/**
 * O ledger da wallet é APPEND-ONLY: nunca se edita nem se apaga um movimento financeiro.
 * Correcções fazem-se com um NOVO movimento (tipo AJUSTE_ADMIN) + AuditLog.
 *
 * Usado como middleware do Prisma (`prisma.$use`, ver src/config/database.js). Bloqueia
 * qualquer update/delete/upsert a WalletTransaction feito através do cliente Prisma.
 * (Os deletes em cascata feitos pela própria BD ao apagar um utilizador não passam por aqui —
 *  política de retenção financeira na eliminação de contas é uma decisão à parte.)
 */

const IMMUTABLE_MODELS = new Set(['WalletTransaction']);
const BLOCKED_ACTIONS = new Set(['update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

class LedgerImmutableError extends Error {
  constructor(model, action) {
    super(`Movimentos financeiros são imutáveis (${model}.${action}). Use um movimento de ajuste.`);
    this.name = 'LedgerImmutableError';
  }
}

function assertMutationAllowed(params) {
  if (params && IMMUTABLE_MODELS.has(params.model) && BLOCKED_ACTIONS.has(params.action)) {
    throw new LedgerImmutableError(params.model, params.action);
  }
}

/** Middleware no formato do `prisma.$use`. */
const ledgerGuardMiddleware = async (params, next) => {
  assertMutationAllowed(params);
  return next(params);
};

module.exports = { assertMutationAllowed, ledgerGuardMiddleware, LedgerImmutableError };
