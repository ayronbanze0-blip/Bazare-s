'use strict';

const { ok, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const walletService = require('../services/walletService');
const zumboPay = require('../services/zumboPayService');
const premiumService = require('../services/premiumService');

const prisma = require('../config/database');

// Depois deste tempo sem confirmação (nem sucesso nem falha reportados pela
// ZumboPay), um pagamento STK "PROCESSANDO" é considerado abandonado — o
// utilizador não completou o PIN, fechou a app, ou o webhook nunca chegou.
// Sem isto, o "inFlight guard" ficaria a bloquear novas tentativas para
// sempre. Configurável via env, default 6 minutos.
const STK_INFLIGHT_EXPIRY_MS = (parseInt(process.env.STK_INFLIGHT_EXPIRY_MIN) || 6) * 60 * 1000;

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
      const ageMs = Date.now() - new Date(inFlight.createdAt).getTime();
      if (ageMs < STK_INFLIGHT_EXPIRY_MS) {
        return badRequest(
          res,
          'Já existe um pagamento em processamento para esta contribuição. Aguarde a confirmação, verifique o estado do pagamento anterior, ou cancele-o para tentar de novo.',
          { pendingPaymentId: inFlight.id }
        );
      }
      // O pedido anterior ultrapassou o tempo limite sem confirmação —
      // trata-se como abandonado e liberta o guard para uma nova tentativa,
      // em vez de deixar o utilizador bloqueado indefinidamente.
      await prisma.commissionPayment.update({
        where: { id: inFlight.id },
        data: { status: 'FALHADA', failReason: 'Expirado — sem confirmação do operador dentro do tempo limite.' }
      });
      logger.warn(`[Wallet.payCommission] STK push ${inFlight.id} expirado automaticamente (${Math.round(ageMs / 60000)} min sem resposta).`);
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

      return ok(res, { reference: chargeResult.reference, id: pending.id }, 'Pedido de pagamento enviado para o seu telemóvel. Introduza o seu PIN para confirmar.');
    } catch (gatewayErr) {
      await prisma.commissionPayment.update({
        where: { id: pending.id },
        data: { status: 'FALHADA', failReason: gatewayErr.message }
      });
      // Timeout/indisponibilidade da operadora é uma condição esperada,
      // não um bug do servidor — devolvemos 400 com a mensagem amigável
      // já preparada em zumboPayService, e a marcação como FALHADA acima
      // liberta logo o "inFlight guard" para o utilizador poder tentar
      // de novo, em vez de ficar bloqueado à espera de um pedido que já
      // sabemos que não vai completar.
      return badRequest(res, gatewayErr.message || 'Não foi possível processar o pagamento. Tente novamente.');
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

// ─── SELLER: Cancel a stuck/in-flight STK push manually ───────────
// Permite ao vendedor destravar o "inFlight guard" sem esperar o
// timeout automático — útil quando ele sabe que já desistiu do PIN
// (fechou o popup, número errado, etc) e quer tentar de novo já.
const cancelCommissionPayment = async (req, res) => {
  try {
    const payment = await prisma.commissionPayment.findUnique({ where: { id: req.params.id } });
    if (!payment) return notFound(res);
    if (payment.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);
    if (payment.status !== 'PROCESSANDO') {
      return badRequest(res, 'Este pagamento já não está em processamento.');
    }
    const updated = await prisma.commissionPayment.update({
      where: { id: payment.id },
      data: { status: 'FALHADA', failReason: 'Cancelado manualmente pelo utilizador.' }
    });
    return ok(res, { payment: updated }, 'Pagamento cancelado. Já pode tentar novamente.');
  } catch (err) {
    logger.error(`[Wallet.cancelCommissionPayment] ${err.message}`);
    return serverError(res);
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════

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

    // A mesma referência nunca pertence às duas tabelas ao mesmo tempo
    // (sourceId tem prefixo diferente — "commission-" vs "premium-"),
    // por isso só procuramos em PremiumSubscription quando não há
    // CommissionPayment correspondente.
    if (!payment) {
      const subscription = await prisma.premiumSubscription.findFirst({ where: { gatewayReference: reference } });

      if (subscription && type === 'payment.succeeded' && subscription.status !== 'PAGA') {
        const claim = await prisma.premiumSubscription.updateMany({
          where: { id: subscription.id, status: { not: 'PAGA' } },
          data: { status: 'PAGA', paidAt: new Date() }
        });

        if (claim.count > 0) {
          const periodEnd = await prisma.$transaction(async (tx) => {
            const end = await premiumService.activateOrExtend(tx, subscription.userId);
            await tx.premiumSubscription.update({
              where: { id: subscription.id },
              data: { periodEnd: end, periodStart: new Date() }
            });
            return end;
          });

          notifSvc.push(subscription.userId, {
            type: 'SUCCESS', title: 'Conta Premium activada! ⭐',
            message: `Pagamento de ${subscription.amount.toLocaleString('pt-MZ')} MT confirmado. Premium válido até ${periodEnd.toLocaleDateString('pt-MZ')}.`,
            link: '/premium'
          });
        }
      }

      if (subscription && type === 'payment.failed' && subscription.status !== 'PAGA') {
        await prisma.premiumSubscription.update({
          where: { id: subscription.id },
          data: { status: 'FALHADA', failReason: event?.data?.message || 'Pagamento falhou.' }
        });
        notifSvc.push(subscription.userId, {
          type: 'ERROR', title: 'Pagamento Premium falhou',
          message: `O pagamento de ${subscription.amount.toLocaleString('pt-MZ')} MT não foi concluído. Tente novamente.`,
          link: '/premium'
        });
      }

      return res.status(200).json({ received: true });
    }

    if (payment && type === 'payment.succeeded' && payment.status !== 'PAGA') {
      const platformAdmin = await walletService.getPlatformAdmin(prisma);

      // Reclama este pagamento de forma atómica: só prossegue se o status
      // ainda não for 'PAGA' neste preciso momento. Gateways de pagamento
      // costumam reenviar o mesmo webhook (garantia "at-least-once") ou
      // podem chegar duas entregas em paralelo — sem isto, a comissão
      // seria creditada duas vezes ao admin da plataforma.
      const claim = await prisma.commissionPayment.updateMany({
        where: { id: payment.id, status: { not: 'PAGA' } },
        data: { status: 'PAGA', paidAt: new Date() }
      });

      if (claim.count > 0) {
        await prisma.$transaction(async (tx) => {
          await walletService.credit(tx, {
            userId: platformAdmin.id,
            amount: payment.amount,
            type: 'CREDITO_COMISSAO',
            description: `Contribuição recebida via ZumboPay (${payment.gatewayChannel || 'mobile money'}) — ref ${reference}`,
            referenceType: 'COMMISSION',
            referenceId: payment.bazarId
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
  myWallet, payCommission, commissionStatus, cancelCommissionPayment,
  adminListCommissionPayments, adminValidateGateway,
  zumboPayWebhook
};

