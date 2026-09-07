'use strict';

// ─────────────────────────────────────────────────────────────────────
// Máquina de estados central para encomendas.
//
// Antes desta correcção, a regra de transição estava espalhada e
// inconsistente entre vendedor/comprador/admin no orderController,
// permitindo: ENTREGUE → CANCELADA, cancelamento duplo, admin a saltar
// estados livremente (ex: PENDENTE → ENTREGUE directo), etc. Esta é
// agora a ÚNICA fonte de verdade — todos os atores (seller/buyer/admin)
// devem passar por `canTransition` antes de qualquer mudança de estado.
// ─────────────────────────────────────────────────────────────────────

const TRANSITIONS = {
  PENDENTE: ['ACEITE', 'CANCELADA'],
  ACEITE: ['EM_PREPARACAO', 'CANCELADA'],
  EM_PREPARACAO: ['EM_ENTREGA', 'CANCELADA'],
  EM_ENTREGA: ['ENTREGUE', 'CANCELADA'],
  ENTREGUE: [],   // terminal — nunca pode ser cancelada ou revertida aqui;
                  // um reembolso pós-entrega precisa de um fluxo próprio.
  CANCELADA: []   // terminal
};

const canTransition = (from, to) => Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);

const isTerminal = (status) => !TRANSITIONS[status] || TRANSITIONS[status].length === 0;

module.exports = { TRANSITIONS, canTransition, isTerminal };
