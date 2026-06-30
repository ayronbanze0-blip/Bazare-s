'use strict';

const { ok, created, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const { uploadToCloud } = require('../services/uploadService');
const walletService = require('../services/walletService');
const zumboPay = require('../services/zumboPayService');

const prisma = require('../config/database');

// Lançado quando, dentro da transacção, o `pendingFees` do bazar já não
// corresponde ao valor esperado — sinal de que outro pedido de pagamento
// (em paralelo / duplo clique) já reclamou esta contribuição primeiro.
class CommissionClaimError extends Error {
  constructor(message = 'Esta contribuição já foi paga ou está a ser processada.') {
    super(message);
    this.name = 'CommissionClaimError';
  }
}

// ─── ME: My wallet balance + recent statement ─────────────────────
const myWallet = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const statement = await walletService.getStatement(prisma, req.user.id, { page, limit });
    return ok(res, statement);
  } catch (err) {
    logger.error(`[Wallet.myWallet] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Transfer to another user (by email or phone) ─────────────
const transfer = async (req, res) => {
  try {
    const { identifier, amount, note } = req.body;
    const value = parseFloat(amount);

    if (!identifier) return badRequest(res, 'Indique o email ou telefone do destinatário.');
    if (!value || value <= 0) return badRequest(res, 'Valor inválido.');

    const recipient = await prisma.user.findFirst({
      where: { OR: [{ email: identifier.trim() }, { phone: identifier.trim() }] }
    });

    if (!recipient) return notFound(res, 'Destinatário não encontrado.');
    if (recipient.id === req.user.id) return badRequest(res, 'Não pode transferir para si mesmo.');

    const description = note?.trim()
      ? `Transferência de ${req.user.name}: ${note.trim()}`
      : `Transferência recebida de ${req.user.name}`;

    const result = await walletService.transfer(prisma, {
      fromUserId: req.user.id,
      toUserId: recipient.id,
      amount: value,
      description
    });

    notifSvc.push(recipient.id, {
      type: 'SUCCESS',
      title: 'Recebeu uma transferência',
      message: `${req.user.name} enviou-lhe ${value.toLocaleString('pt-MZ')} MT.`,
      link: '/wallet'
    });

    logger.info(`[Wallet] Transfer ${value} MT: ${req.user.email} -> ${recipient.email}`);
    return ok(res, { balance: result.from.wallet.balance }, `Transferência de ${value.toLocaleString('pt-MZ')} MT enviada com sucesso.`);
  } catch (err) {
    if (err instanceof walletService.InsufficientFundsError) return badRequest(res, err.message);
    logger.error(`[Wallet.transfer] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Request a manual deposit (proof upload) ──────────────────
const requestDeposit = async (req, res) => {
  try {
    const { amount, method, reference } = req.body;
    const value = parseFloat(amount);

    if (!value || value <= 0) return badRequest(res, 'Valor inválido.');
    if (!['MPESA', 'EMOLA'].includes(method)) return badRequest(res, 'Método inválido. Use MPESA ou EMOLA.');
    if (!req.file) return badRequest(res, 'Comprovativo (imagem) obrigatório.');

    const upload = await uploadToCloud(req.file.path, 'bazares/deposits');
    if (!upload.ok) return serverError(res, 'Erro ao enviar comprovativo.');

    const deposit = await prisma.depositRequest.create({
      data: {
        userId: req.user.id,
        amount: value,
        method,
        proofUrl: upload.url,
        reference: reference || null
      }
    });

    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      notifSvc.push(admin.id, {
        type: 'INFO',
        title: 'Novo pedido de depósito',
        message: `${req.user.name} pediu depósito de ${value.toLocaleString('pt-MZ')} MT.`,
        link: '/admin/wallet'
      });
    }

    return created(res, { deposit }, 'Pedido de depósito enviado. Aguarde aprovação do administrador.');
  } catch (err) {
    logger.error(`[Wallet.requestDeposit] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: My deposit requests ───────────────────────────────────────
const myDeposits = async (req, res) => {
  try {
    const deposits = await prisma.depositRequest.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return ok(res, { deposits });
  } catch (err) {
    logger.error(`[Wallet.myDeposits] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Request a withdrawal ──────────────────────────────────────
const requestWithdrawal = async (req, res) => {
  try {
    const { amount, method, destination, notes } = req.body;
    const value = parseFloat(amount);

    if (!value || value <= 0) return badRequest(res, 'Valor inválido.');
    if (!['MPESA', 'EMOLA'].includes(method)) return badRequest(res, 'Método inválido. Use MPESA ou EMOLA.');
    if (!destination) return badRequest(res, 'Número de destino obrigatório.');

    const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL_MT) || 1000;
    if (value < MIN_WITHDRAWAL) {
      return badRequest(res, `Levantamento mínimo de ${MIN_WITHDRAWAL.toLocaleString('pt-MZ')} MT.`);
    }

    const withdrawal = await prisma.$transaction(async (tx) => {
      // Reserva o saldo já (debita imediatamente) para impedir double-spend
      // enquanto o pedido está pendente; se for rejeitado, devolve-se.
      await walletService.debit(tx, {
        userId: req.user.id,
        amount: value,
        type: 'DEBITO_LEVANTAMENTO',
        description: `Levantamento solicitado — ${method} ${destination}`,
        status: 'PENDENTE'
      });

      return tx.withdrawalRequest.create({
        data: { userId: req.user.id, amount: value, method, destination, notes: notes || null }
      });
    });

    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      notifSvc.push(admin.id, {
        type: 'WARNING',
        title: 'Novo pedido de levantamento',
        message: `${req.user.name} pediu levantamento de ${value.toLocaleString('pt-MZ')} MT.`,
        link: '/admin/wallet'
      });
    }

    return created(res, { withdrawal }, 'Pedido de levantamento enviado. Aguarde processamento.');
  } catch (err) {
    if (err instanceof walletService.InsufficientFundsError) return badRequest(res, err.message);
    logger.error(`[Wallet.requestWithdrawal] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: My withdrawal requests ────────────────────────────────────
const myWithdrawals = async (req, res) => {
  try {
    const withdrawals = await prisma.withdrawalRequest.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return ok(res, { withdrawals });
  } catch (err) {
    logger.error(`[Wallet.myWithdrawals] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Pay platform commission (pendingFees) ─────────────────
// method: 'WALLET' (debita saldo interno, instantâneo) ou
//         'ZUMBOPAY' (dispara STK push para o telefone do vendedor)
const payCommission = async (req, res) => {
  try {
    const { method, msisdn } = req.body;
    if (!['WALLET', 'ZUMBOPAY'].includes(method)) {
      return badRequest(res, 'Método inválido. Use WALLET ou ZUMBOPAY.');
    }

    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.pendingFees <= 0) return badRequest(res, 'Não há contribuição pendente.');

    const amount = bazar.pendingFees;
    const platformAdmin = await walletService.getPlatformAdmin(prisma);

    // ── Caminho 1: pagar com saldo interno da wallet (instantâneo) ──
    if (method === 'WALLET') {
      await prisma.$transaction(async (tx) => {
        // Reclama a contribuição pendente de forma atómica: só prossegue
        // se `pendingFees` ainda corresponder ao valor lido acima. Se um
        // pedido concorrente (ex: duplo clique) já a tiver reclamado
        // primeiro, isto falha e nada é debitado/creditado — evita pagar
        // a mesma comissão duas vezes.
        const claim = await tx.bazar.updateMany({
          where: { id: bazar.id, pendingFees: amount },
          data: { paidFees: { increment: amount }, pendingFees: 0 }
        });
        if (claim.count === 0) throw new CommissionClaimError();

        await walletService.debit(tx, {
          userId: req.user.id,
          amount,
          type: 'DEBITO_COMISSAO',
          description: `Pagamento de contribuição de plataforma (${bazar.name})`,
          referenceType: 'COMMISSION',
          referenceId: bazar.id
        });
        await walletService.credit(tx, {
          userId: platformAdmin.id,
          amount,
          type: 'CREDITO_COMISSAO',
          description: `Contribuição recebida de ${req.user.name} (${bazar.name})`,
          referenceType: 'COMMISSION',
          referenceId: bazar.id
        });
        await tx.commissionPayment.create({
          data: {
            bazarId: bazar.id, sellerId: req.user.id, amount,
            method: 'WALLET', status: 'PAGA', paidAt: new Date()
          }
        });
      });

      notifSvc.push(req.user.id, {
        type: 'SUCCESS', title: 'Contribuição paga',
        message: `Pagamento de ${amount.toLocaleString('pt-MZ')} MT efectuado com sucesso via saldo da wallet.`,
        link: '/wallet'
      });

      return ok(res, {}, 'Contribuição paga com sucesso a partir do saldo da sua wallet.');
    }

    // ── Caminho 2: STK push via ZumboPay (débito real no telefone) ──
    if (!zumboPay.isConfigured()) {
      return badRequest(res, 'Pagamento automático via M-Pesa/e-Mola ainda não está disponível. Tente pagar com saldo da wallet, ou contacte o suporte.');
    }
    if (!msisdn) return badRequest(res, 'Indique o número de telefone para o STK push.');

    // Evita disparar dois STK push em paralelo para a mesma contribuição
    // (ex: duplo clique, ou retry antes do primeiro pedido responder) —
    // sem isto, ambos os pagamentos poderiam ser confirmados pelo
    // webhook e a comissão seria creditada duas vezes ao admin.
    const inFlight = await prisma.commissionPayment.findFirst({
      where: { bazarId: bazar.id, method: 'ZUMBOPAY', status: 'PROCESSANDO' }
    });
    if (inFlight) {
      return badRequest(res, 'Já existe um pagamento em processamento para esta contribuição. Aguarde a confirmação ou verifique o estado do pagamento anterior.');
    }

    const sourceId = `commission-${bazar.id}-${Date.now()}`;
    const pending = await prisma.commissionPayment.create({
      data: {
        bazarId: bazar.id, sellerId: req.user.id, amount,
        method: 'ZUMBOPAY', status: 'PROCESSANDO', msisdn
      }
    });

    try {
      const chargeResult = await zumboPay.initiateCharge({
        amount, msisdn, customerName: req.user.name, sourceId
      });

      await prisma.commissionPayment.update({
        where: { id: pending.id },
        data: {
          gatewayReference: chargeResult.reference,
          gatewayChannel: chargeResult.channel,
          status: chargeResult.status === 'declined' ? 'FALHADA' : 'PROCESSANDO',
          failReason: chargeResult.failReason || null
        }
      });

      if (chargeResult.status === 'declined') {
        return badRequest(res, chargeResult.failReason || 'Pagamento recusado pelo operador.');
      }

      return ok(res, { reference: chargeResult.reference }, 'Pedido de pagamento enviado para o seu telemóvel. Introduza o seu PIN para confirmar.');
    } catch (gatewayErr) {
      await prisma.commissionPayment.update({
        where: { id: pending.id },
        data: { status: 'FALHADA', failReason: gatewayErr.message }
      });
      throw gatewayErr;
    }
  } catch (err) {
    if (err instanceof CommissionClaimError) return badRequest(res, err.message);
    if (err instanceof walletService.InsufficientFundsError) return badRequest(res, err.message);
    logger.error(`[Wallet.payCommission] ${err.message}`);
    return serverError(res, err.message || 'Erro ao processar pagamento.');
  }
};

// ─── SELLER: Check status of a pending commission payment ─────────
const commissionStatus = async (req, res) => {
  try {
    const payment = await prisma.commissionPayment.findUnique({ where: { id: req.params.id } });
    if (!payment) return notFound(res);
    if (payment.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);
    return ok(res, { payment });
  } catch (err) {
    logger.error(`[Wallet.commissionStatus] ${err.message}`);
    return serverError(res);
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════

const adminListDeposits = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [deposits, total] = await Promise.all([
      prisma.depositRequest.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true, phone: true } } }
      }),
      prisma.depositRequest.count({ where })
    ]);
    return ok(res, { deposits, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Wallet.adminListDeposits] ${err.message}`);
    return serverError(res);
  }
};

const adminApproveDeposit = async (req, res) => {
  try {
    const deposit = await prisma.depositRequest.findUnique({ where: { id: req.params.id } });
    if (!deposit) return notFound(res);
    if (deposit.status !== 'PENDENTE') return badRequest(res, 'Este pedido já foi processado.');

    await prisma.$transaction(async (tx) => {
      await walletService.credit(tx, {
        userId: deposit.userId,
        amount: deposit.amount,
        type: 'CREDITO_DEPOSITO',
        description: `Depósito aprovado — ${deposit.method}${deposit.reference ? ` · Ref: ${deposit.reference}` : ''}`,
        referenceType: 'DEPOSIT',
        referenceId: deposit.id
      });
      await tx.depositRequest.update({
        where: { id: deposit.id },
        data: { status: 'APROVADO', reviewedById: req.user.id, reviewedAt: new Date() }
      });
    });

    notifSvc.push(deposit.userId, {
      type: 'SUCCESS', title: 'Depósito aprovado',
      message: `O seu depósito de ${deposit.amount.toLocaleString('pt-MZ')} MT foi aprovado e creditado.`,
      link: '/wallet'
    });

    return ok(res, {}, 'Depósito aprovado e creditado.');
  } catch (err) {
    logger.error(`[Wallet.adminApproveDeposit] ${err.message}`);
    return serverError(res);
  }
};

const adminRejectDeposit = async (req, res) => {
  try {
    const { reason } = req.body;
    const deposit = await prisma.depositRequest.findUnique({ where: { id: req.params.id } });
    if (!deposit) return notFound(res);
    if (deposit.status !== 'PENDENTE') return badRequest(res, 'Este pedido já foi processado.');

    await prisma.depositRequest.update({
      where: { id: deposit.id },
      data: { status: 'REJEITADO', reviewedById: req.user.id, reviewedAt: new Date(), rejectReason: reason || null }
    });

    notifSvc.push(deposit.userId, {
      type: 'ERROR', title: 'Depósito rejeitado',
      message: `O seu depósito de ${deposit.amount.toLocaleString('pt-MZ')} MT foi rejeitado.${reason ? ` Motivo: ${reason}` : ''}`,
      link: '/wallet'
    });

    return ok(res, {}, 'Depósito rejeitado.');
  } catch (err) {
    logger.error(`[Wallet.adminRejectDeposit] ${err.message}`);
    return serverError(res);
  }
};

const adminListWithdrawals = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [withdrawals, total] = await Promise.all([
      prisma.withdrawalRequest.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true, phone: true } } }
      }),
      prisma.withdrawalRequest.count({ where })
    ]);
    return ok(res, { withdrawals, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Wallet.adminListWithdrawals] ${err.message}`);
    return serverError(res);
  }
};

const adminMarkWithdrawalPaid = async (req, res) => {
  try {
    const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: req.params.id } });
    if (!withdrawal) return notFound(res);
    if (withdrawal.status !== 'PENDENTE') return badRequest(res, 'Este pedido já foi processado.');

    // O saldo já foi reservado/debitado no momento do pedido — aqui só
    // confirmamos que o admin pagou de facto fora do sistema, e
    // actualizamos o registo do movimento de PENDENTE para CONCLUIDA.
    await prisma.$transaction(async (tx) => {
      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: { status: 'PAGO', reviewedById: req.user.id, reviewedAt: new Date() }
      });
      const wallet = await tx.wallet.findUnique({ where: { userId: withdrawal.userId } });
      if (wallet) {
        await tx.walletTransaction.updateMany({
          where: { walletId: wallet.id, type: 'DEBITO_LEVANTAMENTO', status: 'PENDENTE' },
          data: { status: 'CONCLUIDA' }
        });
      }
    });

    notifSvc.push(withdrawal.userId, {
      type: 'SUCCESS', title: 'Levantamento pago',
      message: `O seu levantamento de ${withdrawal.amount.toLocaleString('pt-MZ')} MT foi pago via ${withdrawal.method} para ${withdrawal.destination}.`,
      link: '/wallet'
    });

    return ok(res, {}, 'Levantamento marcado como pago.');
  } catch (err) {
    logger.error(`[Wallet.adminMarkWithdrawalPaid] ${err.message}`);
    return serverError(res);
  }
};

const adminRejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;
    const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: req.params.id } });
    if (!withdrawal) return notFound(res);
    if (withdrawal.status !== 'PENDENTE') return badRequest(res, 'Este pedido já foi processado.');

    // Devolve o saldo reservado ao utilizador
    await prisma.$transaction(async (tx) => {
      await walletService.credit(tx, {
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        type: 'AJUSTE_ADMIN',
        description: `Reembolso — levantamento rejeitado${reason ? `: ${reason}` : ''}`,
        referenceType: 'WITHDRAWAL',
        referenceId: withdrawal.id
      });
      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: { status: 'REJEITADO', reviewedById: req.user.id, reviewedAt: new Date(), rejectReason: reason || null }
      });
    });

    notifSvc.push(withdrawal.userId, {
      type: 'ERROR', title: 'Levantamento rejeitado',
      message: `O seu levantamento de ${withdrawal.amount.toLocaleString('pt-MZ')} MT foi rejeitado e o saldo devolvido à sua wallet.${reason ? ` Motivo: ${reason}` : ''}`,
      link: '/wallet'
    });

    return ok(res, {}, 'Levantamento rejeitado e saldo devolvido.');
  } catch (err) {
    logger.error(`[Wallet.adminRejectWithdrawal] ${err.message}`);
    return serverError(res);
  }
};

const adminListCommissionPayments = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [payments, total] = await Promise.all([
      prisma.commissionPayment.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { seller: { select: { name: true, email: true } } }
      }),
      prisma.commissionPayment.count({ where })
    ]);
    return ok(res, { payments, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Wallet.adminListCommissionPayments] ${err.message}`);
    return serverError(res);
  }
};

// ─── ADMIN: diagnostic — validate ZumboPay credentials/wallets ────
const adminValidateGateway = async (req, res) => {
  try {
    if (!zumboPay.isConfigured()) {
      return ok(res, { configured: false }, 'ZumboPay não configurada (faltam variáveis de ambiente).');
    }
    const data = await zumboPay.validateMerchant();
    return ok(res, { configured: true, ...data });
  } catch (err) {
    logger.error(`[Wallet.adminValidateGateway] ${err.message}`);
    return serverError(res, err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK — ZumboPay (não autenticado por JWT; validado por assinatura)
// ═══════════════════════════════════════════════════════════════════

const zumboPayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-zumbopay-signature'];
    const valid = zumboPay.verifyWebhookSignature(req.rawBody, signature);

    if (!valid) {
      logger.warn('[ZumboPay Webhook] Assinatura inválida — pedido ignorado.');
      return res.status(401).json({ success: false, message: 'Assinatura inválida.' });
    }

    const event = req.body;
    const type = event?.type || event?.event;
    const reference = event?.data?.reference;

    logger.info(`[ZumboPay Webhook] Evento recebido: ${type} — ref: ${reference}`);

    if (!reference) {
      return res.status(200).json({ received: true }); // nada a fazer, mas confirmamos recepção
    }

    const payment = await prisma.commissionPayment.findFirst({ where: { gatewayReference: reference } });

    if (payment && type === 'payment.succeeded' && payment.status !== 'PAGA') {
      const platformAdmin = await walletService.getPlatformAdmin(prisma);

      await prisma.$transaction(async (tx) => {
        await walletService.credit(tx, {
          userId: platformAdmin.id,
          amount: payment.amount,
          type: 'CREDITO_COMISSAO',
          description: `Contribuição recebida via ZumboPay (${payment.gatewayChannel || 'mobile money'}) — ref ${reference}`,
          referenceType: 'COMMISSION',
          referenceId: payment.bazarId
        });
        await tx.commissionPayment.update({
          where: { id: payment.id },
          data: { status: 'PAGA', paidAt: new Date() }
        });
        await tx.bazar.update({
          where: { id: payment.bazarId },
          data: { paidFees: { increment: payment.amount }, pendingFees: 0 }
        });
      });

      notifSvc.push(payment.sellerId, {
        type: 'SUCCESS', title: 'Contribuição paga',
        message: `Pagamento de ${payment.amount.toLocaleString('pt-MZ')} MT confirmado via M-Pesa/e-Mola.`,
        link: '/wallet'
      });
    }

    if (payment && type === 'payment.failed' && payment.status !== 'PAGA') {
      await prisma.commissionPayment.update({
        where: { id: payment.id },
        data: { status: 'FALHADA', failReason: event?.data?.message || 'Pagamento falhou.' }
      });
      notifSvc.push(payment.sellerId, {
        type: 'ERROR', title: 'Pagamento falhou',
        message: `O pagamento da contribuição de ${payment.amount.toLocaleString('pt-MZ')} MT não foi concluído. Tente novamente.`,
        link: '/wallet'
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error(`[ZumboPay Webhook] ${err.message}`);
    // Devolvemos 200 mesmo em erro interno para evitar que a ZumboPay
    // fique a reenviar o mesmo webhook indefinidamente; o erro já está
    // registado no log para investigação manual.
    return res.status(200).json({ received: true, warning: 'internal_error_logged' });
  }
};

module.exports = {
  myWallet, transfer, requestDeposit, myDeposits,
  requestWithdrawal, myWithdrawals, payCommission, commissionStatus,
  adminListDeposits, adminApproveDeposit, adminRejectDeposit,
  adminListWithdrawals, adminMarkWithdrawalPaid, adminRejectWithdrawal,
  adminListCommissionPayments, adminValidateGateway,
  zumboPayWebhook
};
