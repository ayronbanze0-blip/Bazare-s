'use strict';

const { ok, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const audit = require('../services/auditService');
const Sentry = require('../config/sentry');
const walletService = require('../services/walletService');
const zumboPay = require('../services/zumboPayService');
const premiumService = require('../services/premiumService');
const webhookEvents = require('../services/webhookEventService');
const ledgerService = require('../services/ledgerService');
const latePayment = require('../services/latePayment');

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
    // Nunca devolver err.message ao cliente (pode expor detalhes do gateway/BD).
    return serverError(res, 'Erro ao processar pagamento.');
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
    // Estado próprio (CANCELADA), distinto de FALHADA (falha do gateway):
    // se o webhook confirmar o pagamento DEPOIS do utilizador o cancelar
    // manualmente aqui, não deve ser reprocessado — ver zumboPayWebhook,
    // que só aceita 'payment.succeeded' quando o estado ainda é
    // 'PROCESSANDO'.
    const updated = await prisma.commissionPayment.update({
      where: { id: payment.id },
      data: { status: 'CANCELADA', failReason: 'Cancelado manualmente pelo utilizador.' }
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
    return serverError(res, 'Não foi possível validar a ligação à ZumboPay.');
  }
};

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK — ZumboPay (não autenticado por JWT; validado por assinatura)
// ═══════════════════════════════════════════════════════════════════

// ─── Pagamento TARDIO (política híbrida — ver services/latePayment.js) ────────────────
// Um `payment.succeeded` que chega para um pagamento já FALHADA/CANCELADA (o cliente pôs o PIN
// depois do prazo ou do cancelamento) significa dinheiro que SAIU do cliente:
//   • caso normal  → credita automaticamente (transacção + claim atómico, idempotente);
//   • caso ambíguo → NÃO credita: AuditLog + Sentry + aviso ao admin, e o cliente é avisado
//                    para não pagar outra vez.
class LatePaymentNeedsReview extends Error {
  constructor(reason) { super(`late_payment_needs_review:${reason}`); this.name = 'LatePaymentNeedsReview'; this.reason = reason; }
}

const flagLateSuccess = (kind, record, reference, reason = 'UNEXPECTED_STATUS') => {
  const meta = { kind, paymentId: record.id, status: record.status, amount: record.amount, reference, reason };
  logger.error(`[ZumboPay Webhook] SUCESSO TARDIO — REVISÃO MANUAL necessária: ${JSON.stringify(meta)}`);
  Sentry.captureMessage('ZumboPay: pagamento confirmado após estado terminal (revisão manual)', { level: 'error', tags: { kind, reason }, extra: meta });
  audit.record(null, 'PAYMENT_LATE_SUCCESS', { entity: kind, entityId: record.id, userId: null, newValue: meta });
};

// Revisão manual: avisa o cliente (para NÃO pagar outra vez) e o admin da plataforma.
const notifyLateReview = async (userId, amount, link) => {
  notifSvc.push(userId, {
    type: 'INFO', title: 'Pagamento recebido — a confirmar',
    message: `Recebemos o teu pagamento de ${amount.toLocaleString('pt-MZ')} MT depois do prazo. Estamos a confirmar — não voltes a pagar. Se houver algum problema, contactamos-te.`,
    link
  });
  try {
    const admin = await walletService.getPlatformAdmin(prisma);
    notifSvc.push(admin.id, {
      type: 'WARNING', title: 'Pagamento tardio para revisão',
      message: `Pagamento de ${amount.toLocaleString('pt-MZ')} MT confirmado após o prazo e NÃO creditado automaticamente. Ver AuditLog (PAYMENT_LATE_SUCCESS).`,
      link: 'finance.html'
    });
  } catch (e) { logger.warn(`[ZumboPay Webhook] Sem admin para avisar: ${e.message}`); }
};

const handleLateCommission = async (payment, reference, event) => {
  const bazar = await prisma.bazar.findUnique({ where: { id: payment.bazarId }, select: { pendingFees: true } });
  let decision = latePayment.decideLateCommission({ payment, pendingFees: bazar ? bazar.pendingFees : 0, eventAmount: event?.data?.amount });

  if (decision.action === 'AUTO_CREDIT') {
    const platformAdmin = await walletService.getPlatformAdmin(prisma);
    try {
      const credited = await prisma.$transaction(async (tx) => {
        // Claim atómico: só UMA entrega (do mesmo evento ou de eventos repetidos) passa.
        const claim = await tx.commissionPayment.updateMany({
          where: { id: payment.id, status: { in: latePayment.LATE_STATUSES } },
          data: { status: 'PAGA', paidAt: new Date(), failReason: null }
        });
        if (claim.count === 0) return false;

        // A dívida só desce se ainda cobrir o valor (condição atómica): se entretanto foi paga por
        // outra via, aborta TODA a transacção (o claim desfaz-se) e passa a revisão manual.
        const applied = await tx.bazar.updateMany({
          where: { id: payment.bazarId, pendingFees: { gte: payment.amount } },
          data: { paidFees: { increment: payment.amount }, pendingFees: { decrement: payment.amount } }
        });
        if (applied.count === 0) throw new LatePaymentNeedsReview('PENDING_FEES_LOWER');

        await walletService.credit(tx, {
          userId: platformAdmin.id,
          amount: payment.amount,
          type: 'CREDITO_COMISSAO',
          description: `Contribuição recebida via ZumboPay (pagamento tardio, ${payment.gatewayChannel || 'mobile money'}) — ref ${reference}`,
          referenceType: 'COMMISSION',
          referenceId: payment.bazarId
        });
        return true;
      });

      if (credited) {
        audit.record(null, 'PAYMENT_LATE_AUTO_CREDITED', {
          entity: 'CommissionPayment', entityId: payment.id, userId: null,
          newValue: { amount: payment.amount, reference, previousStatus: payment.status }
        });
        logger.info(`[ZumboPay Webhook] Pagamento tardio creditado automaticamente (comissão ${payment.id}, ${payment.amount} MT).`);
        notifSvc.push(payment.sellerId, {
          type: 'SUCCESS', title: 'Contribuição paga',
          message: `Recebemos o teu pagamento de ${payment.amount.toLocaleString('pt-MZ')} MT (chegou depois do prazo) e já o contabilizámos.`,
          link: '/wallet'
        });
      }
      return; // creditado, ou outra entrega já o tratou
    } catch (err) {
      if (!(err instanceof LatePaymentNeedsReview)) throw err;
      decision = { action: 'MANUAL_REVIEW', reason: err.reason };
    }
  }

  // Ambíguo → revisão manual (nada foi alterado)
  flagLateSuccess('CommissionPayment', payment, reference, decision.reason);
  if (payment.sellerId) await notifyLateReview(payment.sellerId, payment.amount, '/wallet');
};

const handleLatePremium = async (subscription, reference, event) => {
  const decision = latePayment.decideLatePremium({ subscription, eventAmount: event?.data?.amount });
  if (decision.action === 'AUTO_CREDIT') {
    const periodEnd = await prisma.$transaction(async (tx) => {
      const claim = await tx.premiumSubscription.updateMany({
        where: { id: subscription.id, status: { in: latePayment.LATE_STATUSES } },
        data: { status: 'PAGA', paidAt: new Date(), failReason: null }
      });
      if (claim.count === 0) return null;
      const end = await premiumService.activateOrExtend(tx, subscription.userId);
      await tx.premiumSubscription.update({ where: { id: subscription.id }, data: { periodEnd: end, periodStart: new Date() } });
      return end;
    });
    if (periodEnd) {
      audit.record(null, 'PAYMENT_LATE_AUTO_CREDITED', {
        entity: 'PremiumSubscription', entityId: subscription.id, userId: null,
        newValue: { amount: subscription.amount, reference, previousStatus: subscription.status }
      });
      notifSvc.push(subscription.userId, {
        type: 'SUCCESS', title: 'Conta Premium activada! ⭐',
        message: `Recebemos o teu pagamento de ${subscription.amount.toLocaleString('pt-MZ')} MT (depois do prazo). Premium válido até ${periodEnd.toLocaleDateString('pt-MZ')}.`,
        link: '/premium'
      });
    }
    return;
  }
  flagLateSuccess('PremiumSubscription', subscription, reference, decision.reason);
  await notifyLateReview(subscription.userId, subscription.amount, '/premium');
};

const zumboPayWebhook = async (req, res) => {
  let tracking = null;
  let eventKey = null;
  let failure = null;
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

    // Idempotência ao nível do EVENTO: um evento já processado é confirmado sem repetir nada.
    eventKey = webhookEvents.eventKeyFor(event, req.rawBody);
    tracking = await webhookEvents.begin('zumbopay', eventKey, { type, reference });
    if (tracking.duplicate) {
      logger.info(`[ZumboPay Webhook] Evento duplicado ignorado (${type}, ref ${reference}).`);
      return res.status(200).json({ received: true, duplicate: true });
    }

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

      if (subscription && type === 'payment.succeeded' && subscription.status === 'PROCESSANDO') {
        // O "claim" (status PAGA) e a activação Premium têm de acontecer na
        // MESMA transacção: se ficassem separados e activateOrExtend
        // falhasse depois do claim, o pagamento ficaria marcado como PAGA
        // sem o utilizador ter recebido o Premium (cliente pagou, não
        // recebeu). O updateMany condicional (`status: { not: 'PAGA' } }`)
        // dentro da transacção continua a garantir que webhooks duplicados/
        // concorrentes só processam a activação uma vez.
        const periodEnd = await prisma.$transaction(async (tx) => {
          const claim = await tx.premiumSubscription.updateMany({
            where: { id: subscription.id, status: 'PROCESSANDO' },
            data: { status: 'PAGA', paidAt: new Date() }
          });
          if (claim.count === 0) return null;

          const end = await premiumService.activateOrExtend(tx, subscription.userId);
          await tx.premiumSubscription.update({
            where: { id: subscription.id },
            data: { periodEnd: end, periodStart: new Date() }
          });
          return end;
        });

        if (periodEnd) {
          notifSvc.push(subscription.userId, {
            type: 'SUCCESS', title: 'Conta Premium activada! ⭐',
            message: `Pagamento de ${subscription.amount.toLocaleString('pt-MZ')} MT confirmado. Premium válido até ${periodEnd.toLocaleDateString('pt-MZ')}.`,
            link: '/premium'
          });
        }
      }

      if (subscription && type === 'payment.succeeded' && latePayment.isLateStatus(subscription.status)) {
        await handleLatePremium(subscription, reference, event);
      } else if (subscription && type === 'payment.succeeded' && !['PROCESSANDO', 'PAGA'].includes(subscription.status)) {
        flagLateSuccess('PremiumSubscription', subscription, reference);
      }

      if (subscription && type === 'payment.failed' && subscription.status === 'PROCESSANDO') {
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

    if (payment && type === 'payment.succeeded' && payment.status === 'PROCESSANDO') {
      const platformAdmin = await walletService.getPlatformAdmin(prisma);

      // O claim (status PAGA) e os efeitos financeiros (crédito ao admin +
      // atualização de pendingFees/paidFees) têm de acontecer na MESMA
      // transacção. Antes, o claim (updateMany) corria fora da transacção:
      // se o crédito falhasse depois, o pagamento ficava marcado como PAGA
      // sem o dinheiro ter sido efetivamente movimentado — inconsistência
      // financeira. O `where: { status: { not: 'PAGA' } }` dentro da
      // transacção continua a garantir que webhooks duplicados/concorrentes
      // (entrega "at-least-once" do gateway) só processam uma vez.
      const claimed = await prisma.$transaction(async (tx) => {
        const claim = await tx.commissionPayment.updateMany({
          where: { id: payment.id, status: 'PROCESSANDO' },
          data: { status: 'PAGA', paidAt: new Date() }
        });
        if (claim.count === 0) return false;

        await walletService.credit(tx, {
          userId: platformAdmin.id,
          amount: payment.amount,
          type: 'CREDITO_COMISSAO',
          description: `Contribuição recebida via ZumboPay (${payment.gatewayChannel || 'mobile money'}) — ref ${reference}`,
          referenceType: 'COMMISSION',
          referenceId: payment.bazarId
        });
        // Decrementa só o valor efectivamente pago, nunca zera tudo:
        // entre o STK push ser iniciado e o webhook confirmar (pode
        // demorar minutos), o vendedor pode ter recebido novas
        // encomendas ENTREGUE que aumentaram pendingFees. Um `pendingFees:
        // 0` aqui apagaria essas taxas novas de graça — o mesmo
        // raciocínio do "claim" atómico usado no caminho WALLET acima.
        // A dívida NUNCA fica negativa (condição atómica): normalmente desce o valor todo; se
        // entretanto já desceu por outra via (2.º pagamento, ajuste do admin), desce só o que
        // ainda existe e o EXCESSO fica sinalizado abaixo para revisão manual.
        let applied = 0;
        const full = await tx.bazar.updateMany({
          where: { id: payment.bazarId, pendingFees: { gte: payment.amount } },
          data: { paidFees: { increment: payment.amount }, pendingFees: { decrement: payment.amount } }
        });
        if (full.count === 1) {
          applied = payment.amount;
        } else {
          const bz = await tx.bazar.findUnique({ where: { id: payment.bazarId }, select: { pendingFees: true } });
          const pending = bz ? Math.max(0, bz.pendingFees) : 0;
          if (pending > 0) {
            const part = await tx.bazar.updateMany({
              where: { id: payment.bazarId, pendingFees: { gte: pending } },
              data: { paidFees: { increment: pending }, pendingFees: { decrement: pending } }
            });
            if (part.count === 1) applied = pending;
          }
        }
        return { applied, excess: latePayment.round2(payment.amount - applied) };
      });

      if (claimed) {
        notifSvc.push(payment.sellerId, {
          type: 'SUCCESS', title: 'Contribuição paga',
          message: `Pagamento de ${payment.amount.toLocaleString('pt-MZ')} MT confirmado via M-Pesa/e-Mola.`,
          link: '/wallet'
        });
        // Pagou a mais do que devia (ex.: dois pagamentos para a mesma dívida): o dinheiro foi
        // recebido e creditado à plataforma, mas parte não abateu nenhuma dívida → revisão manual
        // (reembolso ou crédito na wallet do vendedor — decisão do admin).
        if (claimed.excess > latePayment.EPSILON) {
          const meta = { paymentId: payment.id, bazarId: payment.bazarId, amount: payment.amount, applied: claimed.applied, excess: claimed.excess, reference };
          logger.error(`[ZumboPay Webhook] PAGAMENTO EM EXCESSO — revisão manual: ${JSON.stringify(meta)}`);
          Sentry.captureMessage('ZumboPay: pagamento de comissão superior à dívida', { level: 'error', tags: { reason: 'OVERPAYMENT' }, extra: meta });
          audit.record(null, 'PAYMENT_OVERPAYMENT', { entity: 'CommissionPayment', entityId: payment.id, userId: null, newValue: meta });
          notifSvc.push(payment.sellerId, {
            type: 'INFO', title: 'Pagamento acima do valor em dívida',
            message: `Recebemos ${claimed.excess.toLocaleString('pt-MZ')} MT a mais do que devias. Vamos tratar do excesso contigo — não precisas de fazer nada.`,
            link: '/wallet'
          });
        }
      }
    }

    if (payment && type === 'payment.succeeded' && latePayment.isLateStatus(payment.status)) {
      await handleLateCommission(payment, reference, event);
    } else if (payment && type === 'payment.succeeded' && !['PROCESSANDO', 'PAGA'].includes(payment.status)) {
      flagLateSuccess('CommissionPayment', payment, reference);
    }

    if (payment && type === 'payment.failed' && payment.status === 'PROCESSANDO') {
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
    failure = err;
    logger.error(`[ZumboPay Webhook] ${err.message}`);
    // Falha de processamento de um webhook JÁ autenticado: pode significar "pago mas não
    // creditado". Fica registada para reconciliação (AuditLog + Sentry).
    Sentry.captureException(err, { tags: { area: 'zumbopay-webhook' } });
    audit.record(null, 'WEBHOOK_PROCESSING_FAILURE', {
      entity: 'ZumboPayWebhook', userId: null,
      newValue: { reference: req.body?.data?.reference || null, type: req.body?.type || req.body?.event || null, requestId: req.id }
    });
    // Devolvemos 200 mesmo em erro interno para evitar que a ZumboPay
    // fique a reenviar o mesmo webhook indefinidamente; o erro já está
    // registado no log para investigação manual.
    return res.status(200).json({ received: true, warning: 'internal_error_logged' });
  } finally {
    // Regista o resultado depois de responder (nunca lança). Um evento FAILED volta a ser
    // processado se o provider o reenviar; um PROCESSED é ignorado.
    if (tracking && tracking.tracked && !tracking.duplicate) {
      await webhookEvents.finish('zumbopay', eventKey, failure ? { ok: false, error: failure.message } : { ok: true });
    }
  }
};

// ─── ADMIN: reconciliação do ledger ─────────────────────────────────
// GET /api/wallet/admin/ledger/reconcile?page=1&limit=50&all=true
// Compara o saldo de cada wallet com a soma assinada dos seus movimentos. Por omissão só
// devolve as wallets com diferença (ou com movimentos de direcção desconhecida).
const adminReconcileLedger = async (req, res) => {
  try {
    const result = await ledgerService.reconcile(prisma, {
      page: req.query.page, limit: req.query.limit, onlyMismatches: req.query.all !== 'true'
    });
    return ok(res, result);
  } catch (err) {
    logger.error(`[Wallet.adminReconcileLedger] ${err.message}`);
    return serverError(res, 'Não foi possível reconciliar o ledger.');
  }
};

// ─── ADMIN: ajuste de saldo (movimento AJUSTE_ADMIN) ────────────────
// POST /api/wallet/admin/ledger/adjust { userId, amount (±), reason, idempotencyKey }
// Nunca edita saldo directamente nem apaga movimentos: cria um NOVO movimento no ledger,
// na mesma transacção do saldo, com AuditLog. `idempotencyKey` impede duplo clique/reenvio
// (lock consultivo por chave + verificação dentro da transacção).
const adminAdjustWallet = async (req, res) => {
  try {
    const { userId, reason, idempotencyKey } = req.body || {};
    const amount = typeof req.body?.amount === 'number' ? req.body.amount : NaN;

    if (typeof userId !== 'string' || !userId || userId.length > 64) return badRequest(res, 'userId inválido.');
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) {
      return badRequest(res, 'Valor inválido (número diferente de zero, máx. 1.000.000 MT).');
    }
    if (Math.round(amount * 100) !== amount * 100 && Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
      return badRequest(res, 'Valor com mais de 2 casas decimais.');
    }
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanReason.length < 5 || cleanReason.length > 300) return badRequest(res, 'Motivo obrigatório (5 a 300 caracteres).');
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(idempotencyKey)) {
      return badRequest(res, 'idempotencyKey obrigatória (8-64 caracteres: letras, números, . _ -).');
    }

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, active: true } });
    if (!target) return notFound(res, 'Utilizador não encontrado.');

    const isCredit = amount > 0;
    const abs = Math.round(Math.abs(amount) * 100) / 100;
    const referenceType = isCredit ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT';
    const wallet = await walletService.getOrCreateWallet(prisma, userId);

    const outcome = await prisma.$transaction(async (tx) => {
      // Serializa pedidos com a MESMA chave e re-verifica dentro da transacção.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wallet-adjust:' + wallet.id + ':' + idempotencyKey}))`;
      const existing = await tx.walletTransaction.findFirst({
        where: { walletId: wallet.id, referenceId: idempotencyKey, referenceType: { in: ['ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT'] } }
      });
      if (existing) return { duplicate: true, balance: existing.balanceAfter };

      const args = {
        userId, amount: abs, type: 'AJUSTE_ADMIN',
        description: `Ajuste administrativo: ${reason.trim()}`.slice(0, 300),
        referenceType, referenceId: idempotencyKey
      };
      const moved = isCredit ? await walletService.credit(tx, args) : await walletService.debit(tx, args);
      return { duplicate: false, balance: moved.wallet.balance };
    });

    if (!outcome.duplicate) {
      audit.record(req, 'ADMIN_WALLET_LEDGER_ADJUSTMENT', {
        entity: 'Wallet', entityId: wallet.id,
        oldValue: { balance: wallet.balance },
        newValue: { balance: outcome.balance, amount: isCredit ? abs : -abs, reason: cleanReason, idempotencyKey }
      });
      notifSvc.push(userId, {
        type: 'INFO', title: 'Ajuste na wallet',
        message: `O saldo da tua wallet foi ajustado em ${isCredit ? '+' : '-'}${abs.toLocaleString('pt-MZ')} MT.`,
        link: '/wallet'
      });
    }
    return ok(res, { balance: outcome.balance, duplicate: outcome.duplicate }, outcome.duplicate ? 'Ajuste já aplicado (pedido repetido ignorado).' : 'Ajuste aplicado.');
  } catch (err) {
    if (err && err.name === 'InsufficientFundsError') return badRequest(res, err.message);
    logger.error(`[Wallet.adminAdjustWallet] ${err.message}`);
    return serverError(res, 'Não foi possível aplicar o ajuste.');
  }
};

module.exports = {
  myWallet, payCommission, commissionStatus, cancelCommissionPayment,
  adminListCommissionPayments, adminValidateGateway,
  adminReconcileLedger, adminAdjustWallet,
  zumboPayWebhook
};

