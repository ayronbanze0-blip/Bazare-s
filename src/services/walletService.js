'use strict';

/**
 * Wallet Service — núcleo do ledger interno do Bazares.
 *
 * Regras importantes:
 * - Todo o saldo é movido dentro de transacções Prisma ($transaction),
 *   nunca com updates isolados, para evitar corrida de dados (duas
 *   chamadas simultâneas a debitar a mesma wallet).
 * - "amount" é sempre guardado positivo no WalletTransaction; o
 *   significado (crédito/débito) vem do campo "type".
 * - Estas funções assumem que recebem `tx` — o cliente Prisma dentro
 *   de uma transacção já aberta pelo chamador (prisma.$transaction(async tx => {...})).
 *   Isto permite compor wallet + outras tabelas (ex: Order, Bazar) na
 *   mesma transacção atómica.
 */

const logger = require('../utils/logger');

class InsufficientFundsError extends Error {
  constructor(message = 'Saldo insuficiente.') {
    super(message);
    this.name = 'InsufficientFundsError';
    this.statusCode = 400;
  }
}

/**
 * Garante que o utilizador tem uma wallet, criando-a se necessário.
 * Pode ser chamado fora de uma transacção (operação idempotente simples).
 */
const getOrCreateWallet = async (prisma, userId) => {
  let wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) {
    wallet = await prisma.wallet.create({ data: { userId, balance: 0 } });
  }
  return wallet;
};

/**
 * Devolve o saldo actual (cria a wallet se ainda não existir).
 */
const getBalance = async (prisma, userId) => {
  const wallet = await getOrCreateWallet(prisma, userId);
  return wallet.balance;
};

/**
 * Credita uma wallet. Deve ser chamado com `tx` (cliente dentro de uma
 * transacção Prisma). Cria a wallet on-the-fly se ainda não existir.
 */
const credit = async (tx, { userId, amount, type, description, referenceType = null, referenceId = null, status = 'CONCLUIDA' }) => {
  if (!amount || amount <= 0) throw new Error('Valor de crédito inválido.');

  let wallet = await tx.wallet.findUnique({ where: { userId } });
  if (!wallet) wallet = await tx.wallet.create({ data: { userId, balance: 0 } });

  const updated = await tx.wallet.update({
    where: { id: wallet.id },
    data: { balance: { increment: amount } }
  });

  const walletTx = await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type,
      amount,
      balanceAfter: updated.balance,
      description,
      status,
      referenceType,
      referenceId
    }
  });

  return { wallet: updated, transaction: walletTx };
};

// ─── RETENÇÃO ATÉ À ENTREGA ──────────────────────────────────────────
// Conta única: qualquer pessoa pode vender, por isso o dinheiro de uma venda paga com
// a carteira só fica DISPONÍVEL quando a encomenda é entregue (confirmada pelo comprador, ou
// automaticamente pelo job de encomendas). Antes disso o valor já está no saldo (por isso
// reembolsos e cancelamentos continuam a funcionar), mas não pode sair: levantar,
// transferir ou gastar. Calculado em cada pedido — nada para sincronizar.
const OPEN_ORDER_STATUSES = ['PENDENTE', 'ACEITE', 'EM_PREPARACAO', 'EM_ENTREGA'];
const HELD_ENFORCED_TYPES = new Set(['DEBITO_LEVANTAMENTO', 'TRANSFERENCIA_ENVIADA', 'PAGAMENTO_COMPRA']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Valor do saldo retido (vendas pagas pela carteira de encomendas ainda não entregues). */
const heldAmount = async (db, userId, walletId, balance) => {
  const installments = await db.installment.findMany({
    where: { plan: { order: { sellerId: userId, status: { in: OPEN_ORDER_STATUSES } } } },
    select: { id: true }
  });
  if (!installments.length) return 0;
  const agg = await db.walletTransaction.aggregate({
    _sum: { amount: true },
    where: {
      walletId, type: 'RECEBIMENTO_VENDA', status: 'CONCLUIDA', referenceType: 'INSTALLMENT',
      referenceId: { in: installments.map((i) => i.id) }
    }
  });
  return Math.min(round2(agg._sum.amount || 0), round2(balance));
};

/**
 * Debita uma wallet. Lança InsufficientFundsError se o saldo for
 * insuficiente. Deve ser chamado com `tx` dentro de uma transacção.
 */
const debit = async (tx, { userId, amount, type, description, referenceType = null, referenceId = null, status = 'CONCLUIDA' }) => {
  if (!amount || amount <= 0) throw new Error('Valor de débito inválido.');

  let wallet = await tx.wallet.findUnique({ where: { userId } });
  if (!wallet) wallet = await tx.wallet.create({ data: { userId, balance: 0 } });

  // Verificação de saldo + decremento têm de ser a MESMA operação atómica.
  // A versão anterior fazia "if (wallet.balance < amount) throw" e só DEPOIS
  // decrementava — dois débitos concorrentes na mesma wallet (ex.: duplo
  // clique, ou dois pagamentos em paralelo) podiam ambos ler o saldo antigo,
  // ambos passar na verificação, e o saldo final ficar negativo. O `where`
  // abaixo faz o Postgres verificar e decrementar num único passo atómico —
  // impossível dois pedidos concorrentes "passarem" ao mesmo tempo além do
  // saldo disponível.
  const held = HELD_ENFORCED_TYPES.has(type) ? await heldAmount(tx, userId, wallet.id, wallet.balance) : 0;
  const result = await tx.wallet.updateMany({
    where: { id: wallet.id, balance: { gte: round2(amount + held) } },
    data: { balance: { decrement: amount } }
  });

  if (result.count === 0) {
    if (held > 0 && wallet.balance >= amount) {
      const free = Math.max(0, round2(wallet.balance - held));
      throw new InsufficientFundsError(
        `Saldo disponível: ${free.toLocaleString('pt-MZ')} MT. ${held.toLocaleString('pt-MZ')} MT das tuas vendas ficam retidos até à entrega das encomendas.`);
    }
    throw new InsufficientFundsError(`Saldo insuficiente. Disponível: ${wallet.balance.toLocaleString('pt-MZ')} MT.`);
  }

  const updated = await tx.wallet.findUnique({ where: { id: wallet.id } });

  const walletTx = await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type,
      amount,
      balanceAfter: updated.balance,
      description,
      status,
      referenceType,
      referenceId
    }
  });

  return { wallet: updated, transaction: walletTx };
};

/**
 * Transferência interna wallet → wallet entre dois utilizadores do
 * Bazares. Atómica: ou debita+credita ambos, ou nada acontece.
 */
const transfer = async (prisma, { fromUserId, toUserId, amount, description, referenceType = 'TRANSFER', referenceId = null }) => {
  if (fromUserId === toUserId) throw new Error('Não pode transferir para si mesmo.');
  if (!amount || amount <= 0) throw new Error('Valor de transferência inválido.');

  return prisma.$transaction(async (tx) => {
    const debited = await debit(tx, {
      userId: fromUserId,
      amount,
      type: 'TRANSFERENCIA_ENVIADA',
      description,
      referenceType,
      referenceId
    });

    const credited = await credit(tx, {
      userId: toUserId,
      amount,
      type: 'TRANSFERENCIA_RECEBIDA',
      description,
      referenceType,
      referenceId
    });

    return { from: debited, to: credited };
  });
};

/**
 * Extracto paginado de uma wallet.
 */
const getStatement = async (prisma, userId, { page = 1, limit = 30 } = {}) => {
  const wallet = await getOrCreateWallet(prisma, userId);
  const take = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take, skip
    }),
    prisma.walletTransaction.count({ where: { walletId: wallet.id } })
  ]);

  return {
    balance: wallet.balance,
    transactions,
    meta: { total, page: parseInt(page) || 1, limit: take, pages: Math.ceil(total / take) }
  };
};

/**
 * Resolve o utilizador "admin da plataforma" — quem recebe a comissão
 * (paga pelos vendedores pelo uso do Bazares).
 *
 * Configurável via PLATFORM_ADMIN_EMAIL; se não definido, usa o
 * primeiro ADMIN criado (mais antigo) como fallback razoável.
 */
const getPlatformAdmin = async (prisma) => {
  const configuredEmail = process.env.PLATFORM_ADMIN_EMAIL;
  if (configuredEmail) {
    const admin = await prisma.user.findUnique({ where: { email: configuredEmail } });
    if (admin) return admin;
    logger.warn(`[Wallet] PLATFORM_ADMIN_EMAIL "${configuredEmail}" não encontrado — a usar fallback.`);
  }

  const fallback = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' }
  });

  if (!fallback) throw new Error('Nenhum utilizador ADMIN encontrado para receber comissões.');
  return fallback;
};

module.exports = {
  InsufficientFundsError,
  getOrCreateWallet,
  getBalance,
  credit,
  debit,
  heldAmount,
  transfer,
  getStatement,
  getPlatformAdmin
};

