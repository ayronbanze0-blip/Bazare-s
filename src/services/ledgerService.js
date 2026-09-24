'use strict';

/**
 * Ledger da wallet — reconciliação e ajustes administrativos.
 *
 * O saldo (`Wallet.balance`) tem de ser SEMPRE igual à soma assinada dos movimentos
 * (`WalletTransaction`). `reconcile` verifica isso; `expectedBalance` é lógica pura (testável).
 *
 * Direcção de cada tipo (o `amount` é sempre positivo no ledger):
 *   crédito:  CREDITO_DEPOSITO, TRANSFERENCIA_RECEBIDA, CREDITO_COMISSAO
 *   débito:   DEBITO_LEVANTAMENTO, TRANSFERENCIA_ENVIADA, DEBITO_COMISSAO
 *   ajuste:   AJUSTE_ADMIN — direcção em referenceType: ADJUSTMENT_CREDIT | ADJUSTMENT_DEBIT
 */

const CREDIT_TYPES = new Set(['CREDITO_DEPOSITO', 'TRANSFERENCIA_RECEBIDA', 'CREDITO_COMISSAO']);
const DEBIT_TYPES = new Set(['DEBITO_LEVANTAMENTO', 'TRANSFERENCIA_ENVIADA', 'DEBITO_COMISSAO']);
const TOLERANCE = 0.01; // 1 cêntimo (o saldo é Float)

/** +amount, -amount, ou null se a direcção não puder ser determinada. */
function signedAmount({ type, referenceType, amount }) {
  if (CREDIT_TYPES.has(type)) return amount;
  if (DEBIT_TYPES.has(type)) return -amount;
  if (type === 'AJUSTE_ADMIN') {
    if (referenceType === 'ADJUSTMENT_CREDIT') return amount;
    if (referenceType === 'ADJUSTMENT_DEBIT') return -amount;
  }
  return null;
}

/**
 * @param groups  [{ type, referenceType, sum }] — soma de `amount` por (type, referenceType)
 * @returns {{ expected:number, unknown:object[] }}
 */
function expectedBalance(groups) {
  let expected = 0;
  const unknown = [];
  for (const g of groups) {
    const s = signedAmount({ type: g.type, referenceType: g.referenceType, amount: g.sum || 0 });
    if (s === null) unknown.push({ type: g.type, referenceType: g.referenceType, sum: g.sum || 0 });
    else expected += s;
  }
  return { expected: Math.round(expected * 100) / 100, unknown };
}

/**
 * Reconcilia uma página de wallets (máx. 100). Usa UMA agregação (groupBy) por página —
 * nunca lê movimento a movimento.
 */
async function reconcile(prisma, { page = 1, limit = 50, onlyMismatches = true } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const skip = (Math.min(Math.max(parseInt(page, 10) || 1, 1), 100000) - 1) * take;

  const [wallets, total] = await Promise.all([
    prisma.wallet.findMany({ orderBy: { id: 'asc' }, take, skip, select: { id: true, userId: true, balance: true } }),
    prisma.wallet.count()
  ]);
  if (wallets.length === 0) return { items: [], summary: { checked: 0, mismatches: 0 }, meta: { total, page: 1, limit: take, pages: 0 } };

  const rows = await prisma.walletTransaction.groupBy({
    by: ['walletId', 'type', 'referenceType'],
    where: { walletId: { in: wallets.map((w) => w.id) } },
    _sum: { amount: true }
  });
  const byWallet = new Map();
  for (const r of rows) {
    if (!byWallet.has(r.walletId)) byWallet.set(r.walletId, []);
    byWallet.get(r.walletId).push({ type: r.type, referenceType: r.referenceType, sum: r._sum.amount });
  }

  const results = wallets.map((w) => {
    const { expected, unknown } = expectedBalance(byWallet.get(w.id) || []);
    const diff = Math.round((w.balance - expected) * 100) / 100;
    return {
      walletId: w.id, userId: w.userId, balance: w.balance, expected, diff,
      ok: Math.abs(diff) <= TOLERANCE && unknown.length === 0,
      unknownDirection: unknown
    };
  });
  const mismatches = results.filter((r) => !r.ok);
  return {
    items: onlyMismatches ? mismatches : results,
    summary: { checked: results.length, mismatches: mismatches.length },
    meta: { total, page: Math.floor(skip / take) + 1, limit: take, pages: Math.ceil(total / take) }
  };
}

module.exports = { signedAmount, expectedBalance, reconcile, TOLERANCE, CREDIT_TYPES, DEBIT_TYPES };
