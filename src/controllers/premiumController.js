'use strict';

const { ok, badRequest, forbidden, notFound, serverError } = require('../utils/response');
const { paginate, paginateMeta } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');
const premiumService = require('../services/premiumService');
const zumboPay = require('../services/zumboPayService');

const prisma = require('../config/database');

// Mesmo raciocínio do STK_INFLIGHT_EXPIRY_MS em walletController: depois
// deste tempo sem confirmação, uma subscrição "PROCESSANDO" é tratada
// como abandonada e deixa de bloquear novas tentativas.
const STK_INFLIGHT_EXPIRY_MS = (parseInt(process.env.STK_INFLIGHT_EXPIRY_MIN) || 6) * 60 * 1000;

// ─── ME: Estado actual da minha conta Premium ──────────────────────
const myStatus = async (req, res) => {
  try {
    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return notFound(res);

    user = await premiumService.downgradeIfExpired(prisma, user);

    return ok(res, {
      isPremium: premiumService.isActive(user),
      premiumSince: user.premiumSince,
      premiumExpiresAt: user.premiumExpiresAt,
      price: premiumService.PREMIUM_PRICE_MT,
      feeRate: premiumService.PREMIUM_FEE_RATE
    });
  } catch (err) {
    logger.error(`[Premium.myStatus] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Iniciar/renovar assinatura via STK push (M-Pesa/e-Mola) ──
const subscribe = async (req, res) => {
  try {
    const { msisdn } = req.body;
    if (!msisdn) return badRequest(res, 'Indique o número de telefone para o STK push.');

    if (!zumboPay.isConfigured()) {
      return badRequest(res, 'Pagamento automático via M-Pesa/e-Mola ainda não está disponível. Tente novamente mais tarde ou contacte o suporte.');
    }

    // Evita disparar dois STK push em paralelo para a mesma subscrição —
    // sem isto, o webhook podia confirmar ambos e estender o período
    // duas vezes.
    const inFlight = await prisma.premiumSubscription.findFirst({
      where: { userId: req.user.id, status: 'PROCESSANDO' }
    });
    if (inFlight) {
      const ageMs = Date.now() - new Date(inFlight.createdAt).getTime();
      if (ageMs < STK_INFLIGHT_EXPIRY_MS) {
        return badRequest(
          res,
          'Já existe um pagamento Premium em processamento. Aguarde a confirmação ou cancele-o para tentar de novo.',
          { pendingSubscriptionId: inFlight.id }
        );
      }
      await prisma.premiumSubscription.update({
        where: { id: inFlight.id },
        data: { status: 'FALHADA', failReason: 'Expirado — sem confirmação do operador dentro do tempo limite.' }
      });
      logger.warn(`[Premium.subscribe] STK push ${inFlight.id} expirado automaticamente (${Math.round(ageMs / 60000)} min sem resposta).`);
    }

    const amount = premiumService.PREMIUM_PRICE_MT;
    const sourceId = `premium-${req.user.id}-${Date.now()}`;
    const pending = await prisma.premiumSubscription.create({
      data: { userId: req.user.id, amount, status: 'PROCESSANDO', msisdn }
    });

    try {
      const chargeResult = await zumboPay.initiateCharge({
        amount, msisdn, customerName: req.user.name, sourceId
      });

      await prisma.premiumSubscription.update({
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

      return ok(res, { reference: chargeResult.reference, id: pending.id, amount },
        'Pedido de pagamento enviado para o seu telemóvel. Introduza o seu PIN para confirmar e activar a Conta Premium.');
    } catch (gatewayErr) {
      await prisma.premiumSubscription.update({
        where: { id: pending.id },
        data: { status: 'FALHADA', failReason: gatewayErr.message }
      });
      return badRequest(res, gatewayErr.message || 'Não foi possível processar o pagamento. Tente novamente.');
    }
  } catch (err) {
    logger.error(`[Premium.subscribe] ${err.message}`);
    return serverError(res, err.message || 'Erro ao iniciar a subscrição Premium.');
  }
};

// ─── ME: Consultar estado de uma tentativa de pagamento ────────────
const subscriptionStatus = async (req, res) => {
  try {
    const sub = await prisma.premiumSubscription.findUnique({ where: { id: req.params.id } });
    if (!sub) return notFound(res);
    if (sub.userId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);
    return ok(res, { subscription: sub });
  } catch (err) {
    logger.error(`[Premium.subscriptionStatus] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Cancelar um STK push preso em "PROCESSANDO" ───────────────
const cancelSubscription = async (req, res) => {
  try {
    const sub = await prisma.premiumSubscription.findUnique({ where: { id: req.params.id } });
    if (!sub) return notFound(res);
    if (sub.userId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);
    if (sub.status !== 'PROCESSANDO') return badRequest(res, 'Este pagamento já não está em processamento.');

    const updated = await prisma.premiumSubscription.update({
      where: { id: sub.id },
      data: { status: 'FALHADA', failReason: 'Cancelado manualmente pelo utilizador.' }
    });
    return ok(res, { subscription: updated }, 'Pagamento cancelado. Já pode tentar novamente.');
  } catch (err) {
    logger.error(`[Premium.cancelSubscription] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Analytics avançado (exclusivo Premium) ────────────────────
// Vendas por dia (últimos 30 dias), top produtos e distribuição por
// categoria — além dos números básicos já disponíveis em /finance
// para todos os vendedores.
const analytics = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    user = await premiumService.downgradeIfExpired(prisma, user);
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'O analytics avançado é exclusivo da Conta Premium.');
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orders, topProducts] = await Promise.all([
      prisma.order.findMany({
        where: { sellerId: req.user.id, createdAt: { gte: since }, status: { not: 'CANCELADA' } },
        select: { total: true, subtotal: true, createdAt: true }
      }),
      prisma.product.findMany({
        where: { sellerId: req.user.id, active: true },
        orderBy: { sales: 'desc' },
        take: 10,
        select: { id: true, name: true, sales: true, views: true, price: true, category: true }
      })
    ]);

    // Agrupa vendas por dia (YYYY-MM-DD) para o gráfico
    const byDay = {};
    for (const o of orders) {
      const day = o.createdAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + o.total;
    }
    const salesByDay = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, total]) => ({ date, total }));

    // Distribuição por categoria (a partir do top de produtos por vendas)
    const byCategory = {};
    for (const p of topProducts) {
      byCategory[p.category] = (byCategory[p.category] || 0) + p.sales;
    }

    return ok(res, {
      salesByDay,
      topProducts,
      categoryBreakdown: Object.entries(byCategory).map(([category, sales]) => ({ category, sales })),
      totalOrders30d: orders.length,
      totalRevenue30d: orders.reduce((sum, o) => sum + o.total, 0)
    });
  } catch (err) {
    logger.error(`[Premium.analytics] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Melhorador de fotografias ──────────────────────────────
const enhancePhoto = async (req, res) => {
  try {
    const { imageUrl, imageId } = req.body;
    if (!imageUrl) return badRequest(res, 'Indique o URL da imagem a melhorar.');

    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    user = await premiumService.downgradeIfExpired(prisma, user);
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'O melhorador de fotografias é exclusivo da Conta Premium.');
    }

    const enhancedUrl = premiumService.buildEnhancedPhotoUrl(imageUrl);
    if (!enhancedUrl) return badRequest(res, 'Esta imagem não pode ser melhorada (não pertence à Bazares).');

    // Se veio o id da imagem do produto, gravamos já o URL melhorado —
    // sem isto, a melhoria só existia na sessão de edição actual e
    // desaparecia ao recarregar a página (o URL guardado continuava a
    // apontar para o original).
    if (imageId) {
      const image = await prisma.productImage.findUnique({
        where: { id: imageId },
        include: { product: { select: { sellerId: true } } }
      });
      if (image && image.product.sellerId === req.user.id) {
        await prisma.productImage.update({ where: { id: imageId }, data: { url: enhancedUrl } });
      }
    }

    return ok(res, { enhancedUrl });
  } catch (err) {
    logger.error(`[Premium.enhancePhoto] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Assistente de preços ───────────────────────────────────
// Sugestão baseada nos preços reais de produtos activos e semelhantes
// já publicados na Bazares — sem depender da API de IA (que já teve
// problemas de quota), por isso é rápido e sempre disponível.
const priceSuggestion = async (req, res) => {
  try {
    const { category, name } = req.query;
    if (!category) return badRequest(res, 'Indique a categoria do produto.');

    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    user = await premiumService.downgradeIfExpired(prisma, user);
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'O assistente de preços é exclusivo da Conta Premium.');
    }

    const where = { category, active: true, stock: { gt: 0 } };
    const sameCategory = await prisma.product.findMany({
      where, select: { price: true, name: true }, take: 500
    });

    if (sameCategory.length < 3) {
      return ok(res, {
        sampleSize: sameCategory.length,
        message: 'Ainda não há produtos suficientes nesta categoria para uma sugestão fiável.'
      });
    }

    // Se o nome do produto partilhar palavras com outros já publicados,
    // restringe a amostra a esses — mais preciso que a categoria inteira.
    let sample = sameCategory;
    if (name && name.trim().length > 2) {
      const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const narrowed = sameCategory.filter(p =>
        words.some(w => p.name.toLowerCase().includes(w))
      );
      if (narrowed.length >= 3) sample = narrowed;
    }

    const prices = sample.map(p => p.price).sort((a, b) => a - b);
    const sum = prices.reduce((s, p) => s + p, 0);
    const avg = sum / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];
    // Sugestão: ligeiramente abaixo da mediana, para ficar competitivo
    // sem se afastar demasiado do valor de mercado.
    const suggested = Math.round(median * 0.95 / 5) * 5;

    return ok(res, {
      sampleSize: sample.length,
      min: Math.round(min), max: Math.round(max),
      average: Math.round(avg), median: Math.round(median),
      suggested
    });
  } catch (err) {
    logger.error(`[Premium.priceSuggestion] ${err.message}`);
    return serverError(res);
  }
};

// ─── ME: Respostas rápidas personalizadas (chat) ───────────────
const listQuickReplies = async (req, res) => {
  try {
    const replies = await prisma.quickReply.findMany({
      where: { sellerId: req.user.id },
      orderBy: { order: 'asc' }
    });
    return ok(res, { replies });
  } catch (err) {
    logger.error(`[Premium.listQuickReplies] ${err.message}`);
    return serverError(res);
  }
};

const createQuickReply = async (req, res) => {
  try {
    const { label, text } = req.body;
    if (!label?.trim() || !text?.trim()) return badRequest(res, 'Indique um título e o texto da resposta.');

    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    user = await premiumService.downgradeIfExpired(prisma, user);
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'Respostas rápidas personalizadas são exclusivas da Conta Premium.');
    }

    const count = await prisma.quickReply.count({ where: { sellerId: req.user.id } });
    if (count >= 12) return badRequest(res, 'Limite de 12 respostas rápidas atingido.');

    const reply = await prisma.quickReply.create({
      data: { sellerId: req.user.id, label: label.trim().slice(0, 40), text: text.trim().slice(0, 500), order: count }
    });
    return ok(res, { reply }, 'Resposta rápida criada.');
  } catch (err) {
    logger.error(`[Premium.createQuickReply] ${err.message}`);
    return serverError(res);
  }
};

const deleteQuickReply = async (req, res) => {
  try {
    const reply = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
    if (!reply) return notFound(res);
    if (reply.sellerId !== req.user.id) return forbidden(res);
    await prisma.quickReply.delete({ where: { id: reply.id } });
    return ok(res, {}, 'Resposta rápida removida.');
  } catch (err) {
    logger.error(`[Premium.deleteQuickReply] ${err.message}`);
    return serverError(res);
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════

const adminList = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const { take, skip } = paginate(page, limit);
    const where = status ? { status } : {};
    const [subscriptions, total] = await Promise.all([
      prisma.premiumSubscription.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, email: true } } }
      }),
      prisma.premiumSubscription.count({ where })
    ]);
    return ok(res, { subscriptions, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Premium.adminList] ${err.message}`);
    return serverError(res);
  }
};

// Concede/revoga Premium manualmente (suporte, testes, cortesias) sem
// passar pelo STK push.
const adminGrant = async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return notFound(res, 'Utilizador não encontrado.');

    const result = await prisma.$transaction(async (tx) => {
      const periodEnd = await premiumService.activateOrExtend(tx, target.id);
      return periodEnd;
    });

    notifSvc.push(target.id, {
      type: 'SUCCESS', title: 'Conta Premium activada! ⭐',
      message: 'A sua Conta Premium foi activada pela equipa Bazares.',
      link: '/premium'
    });

    logger.info(`[Admin] Premium concedido a ${target.email} até ${result.toISOString()} por ${req.user.email}`);
    return ok(res, { premiumExpiresAt: result }, 'Conta Premium activada.');
  } catch (err) {
    logger.error(`[Premium.adminGrant] ${err.message}`);
    return serverError(res);
  }
};

const adminRevoke = async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return notFound(res, 'Utilizador não encontrado.');

    await prisma.user.update({ where: { id: target.id }, data: { isPremium: false } });
    logger.info(`[Admin] Premium revogado de ${target.email} por ${req.user.email}`);
    return ok(res, {}, 'Conta Premium revogada.');
  } catch (err) {
    logger.error(`[Premium.adminRevoke] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  myStatus, subscribe, subscriptionStatus, cancelSubscription, analytics,
  enhancePhoto, priceSuggestion, listQuickReplies, createQuickReply, deleteQuickReply,
  adminList, adminGrant, adminRevoke
};
