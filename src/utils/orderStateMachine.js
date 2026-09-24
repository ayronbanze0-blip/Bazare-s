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

// ─── Quem pode fazer cada transição ────────────────────────────────
// O COMPRADOR pode cancelar enquanto a encomenda ainda NÃO saiu para entrega
// (PENDENTE, ACEITE, EM_PREPARACAO). Depois de EM_ENTREGA já não: o artigo está
// a caminho — o comprador só pode confirmar a entrega (ENTREGUE).
// O VENDEDOR faz avançar/cancelar mas nunca confirma a entrega (só o comprador ou o admin).
// O ADMIN pode qualquer transição válida da máquina de estados (fica auditado).
const BUYER_CANCEL_FROM = ['PENDENTE', 'ACEITE', 'EM_PREPARACAO'];

/**
 * @param {'buyer'|'seller'|'admin'} actor
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function actorMayTransition(actor, from, to) {
  if (actor === 'admin') return { ok: true };
  if (actor === 'buyer') {
    if (to === 'ENTREGUE') return { ok: true };
    if (to === 'CANCELADA') {
      return BUYER_CANCEL_FROM.includes(from)
        ? { ok: true }
        : { ok: false, reason: 'Já não é possível cancelar: a encomenda já saiu para entrega.' };
    }
    return { ok: false, reason: 'Compradores só podem cancelar (antes da entrega) ou confirmar a entrega.' };
  }
  if (actor === 'seller') {
    if (to === 'ENTREGUE') return { ok: false, reason: 'Apenas o comprador pode confirmar a entrega.' };
    return { ok: true };
  }
  return { ok: false, reason: 'Sem permissão.' };
}

module.exports = { TRANSITIONS, BUYER_CANCEL_FROM, canTransition, isTerminal, actorMayTransition };
