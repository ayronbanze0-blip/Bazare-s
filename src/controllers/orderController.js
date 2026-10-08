'use strict';

const { validationResult } = require('express-validator');

const { ok, created, domainError, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, calcFee, parseLatLng, sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const eventBus = require('../services/eventBus');
const emailSvc = require('../services/emailService');
const premiumService = require('../services/premiumService');
const logger = require('../utils/logger');
const { canTransition, isTerminal, actorMayTransition } = require('../utils/orderStateMachine');
const audit = require('../services/auditService');
const { normalizeOrderItems, validateOrderText } = require('../utils/orderItems');
const { blockedAmong } = require('../services/blockService');
const checkoutSvc = require('../services/checkoutService');
const couponSvc = require('../services/couponService');
const installmentSvc = require('../services/installmentService');
const walletFlow = require('../services/walletFlowService');
const { envEnabled } = require('../config/features');
const { replyKnown } = require('../utils/appError');

const prisma = require('../config/database');

const FEE_LIMIT_PARSED = parseFloat(process.env.FEE_LIMIT_MT);
const FEE_LIMIT = Number.isFinite(FEE_LIMIT_PARSED) ? FEE_LIMIT_PARSED : 150;
// Alerta de stock baixo: dispara UMA vez, quando o stock CRUZA o limiar (ou chega a 0)
// por causa de uma compra — por isso não repete a notificação a cada encomenda.
const LOW_STOCK_THRESHOLD = Math.max(1, parseInt(process.env.LOW_STOCK_THRESHOLD, 10) || 3);
const STATUS_FLOW = ['PENDENTE', 'ACEITE', 'EM_PREPARACAO', 'EM_ENTREGA', 'ENTREGUE', 'CANCELADA'];

// Lançado quando a transição de estado pedida já não é válida no momento
// exacto em que tentamos aplicá-la — ou porque outra chamada concorrente
// já mudou o estado entretanto (ex: dois cliques em "cancelar", ou um
// vendedor a marcar EM_ENTREGA ao mesmo tempo que o comprador cancela),
// ou porque a transição nunca foi permitida. O `updateMany` condicional
// abaixo (`where: { status: order.status }`) é a garantia real contra
// isto — a verificação síncrona é só para dar uma mensagem de erro cedo.
class InvalidTransitionError extends Error {
  constructor(message = 'Esta encomenda já não pode ser alterada para este estado — o estado pode ter mudado entretanto.') {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

// Lançado quando o stock real (verificado de forma atómica dentro da
// transacção) já não é suficiente no momento do decremento — por exemplo
// quando dois pedidos concorrentes disputam a última unidade. A verificação
// feita antes da transacção é apenas uma pré-checagem para UX rápida; esta
// é a garantia real contra overselling.
class StockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StockError';
  }
}

// ─── Pagamentos com a carteira ligados? (env + flag em tempo real; fail-open se a BD falhar) ──
const paymentsEnabled = async () => {
  if (!envEnabled('ENABLE_PAYMENTS')) return false;
  try { return await require('../services/featureFlags').isEnabled('enable_payments', true); } catch { return true; }
};

// ─── BUYER: Place order ───────────────────────────────────────────
// O cliente envia só intenções (itens, cupão, zona de entrega, forma de pagamento). Preços, descontos,
// entrega, juros e total são calculados no servidor por checkoutService — o MESMO cálculo de POST /checkout/quote.
const placeOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { buyerName, buyerPhone, address, latitude, longitude, payment, size, color, notes } = req.body;
  const geo = parseLatLng(latitude, longitude);

  // Nunca confiar no formato de req.body: quantidades têm de ser inteiros, linhas
  // repetidas são fundidas e os textos livres têm tipo/tamanho validados.
  const normalized = normalizeOrderItems(req.body.items);
  if (normalized.error) return badRequest(res, normalized.error);
  const items = normalized.items;

  const textError = validateOrderText({ buyerName, buyerPhone, address, payment, size, color, notes });
  if (textError) return badRequest(res, textError);

  try {
    const checkout = await checkoutSvc.buildCheckout({
      buyerId: req.user.id,
      items,
      couponCode: req.body.couponCode,
      deliveryZones: req.body.deliveryZones !== undefined ? req.body.deliveryZones : req.body.deliveryZoneId,
      paymentMode: req.body.paymentMode,
      installments: req.body.installments
    });
    const mode = checkout.paymentMode;

    // Pagar com a carteira: funcionalidade ligada + PIN correcto + saldo para o que se paga AGORA.
    if (mode !== 'ENTREGA') {
      if (!(await paymentsEnabled())) return domainError(res, 503, 'FEATURE_DISABLED', 'Pagamentos com a carteira temporariamente indisponíveis.');
      await walletFlow.verifyPin(req.user.id, typeof req.body.pin === 'string' ? req.body.pin : '');
      const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.id }, select: { balance: true } });
      const balance = wallet ? wallet.balance : 0;
      if (balance + 1e-9 < checkout.totals.payNow) {
        return domainError(res, 400, 'INSUFFICIENT_FUNDS', `Saldo insuficiente. Precisas de ${checkout.totals.payNow.toLocaleString('pt-MZ')} MT e tens ${balance.toLocaleString('pt-MZ')} MT.`, { required: checkout.totals.payNow, balance });
      }
    }
    const autoPay = req.body.autoPay === undefined ? true : req.body.autoPay === true || req.body.autoPay === 'true';

    const createdOrders = [];
    const sellerGroups = {}; // para os alertas de stock (como antes)

    await prisma.$transaction(async (tx) => {
      for (const g of checkout.groups) {
        const paymentLabel = mode === 'CARTEIRA' ? 'Carteira Bazares'
          : mode === 'PARCELAS' ? `Parcelado em ${g.installments.count}x (Carteira Bazares)`
            : (payment ? sanitize(payment) : 'Pagamento na entrega');

        const order = await tx.order.create({
          data: {
            buyerId: req.user.id,
            sellerId: g.sellerId,
            bazarId: g.bazar.id,
            buyerName: buyerName ? sanitize(buyerName) : req.user.name,
            buyerPhone: sanitize(buyerPhone),
            address: sanitize(address),
            latitude: geo?.latitude ?? null,
            longitude: geo?.longitude ?? null,
            payment: paymentLabel,
            paymentMode: mode,
            size: size ? sanitize(size) : null,
            color: color ? sanitize(color) : null,
            notes: notes ? sanitize(notes) : null,
            subtotal: g.subtotal,
            discountAmount: g.discount,
            couponCode: g.coupon ? g.coupon.code : null,
            shippingFee: g.shippingFee,
            shippingZone: g.delivery ? g.delivery.name : null,
            feeRate: g.feeRate,
            feeAmount: g.feeAmount,
            total: g.total,
            items: {
              create: g.lines.map((l) => ({
                productId: l.productId,
                name: l.name,
                // Preço PAGO (já com promoção). `originalPrice` guarda o de tabela para mostrar a poupança
                // — histórico imutável, mesmo que o produto mude ou seja apagado depois.
                price: l.unitPrice,
                originalPrice: l.onSale ? l.listPrice : null,
                qty: l.qty,
                imageUrl: l.imageUrl
              }))
            }
          },
          include: { items: true }
        });

        await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'PENDENTE', actorId: req.user.id, actorRole: 'buyer' } });

        if (g._internal.coupon) {
          await couponSvc.redeemTx(tx, { coupon: g._internal.coupon, userId: req.user.id, orderId: order.id, amount: g.discount });
        }

        // Decrement stock atomically: só decrementa se o stock disponível
        // neste preciso momento (dentro da transacção) ainda for suficiente.
        // Isto evita overselling quando dois pedidos concorrentes disputam
        // o mesmo produto — a pré-checagem em buildCheckout pode estar desactualizada
        // por essa altura, esta é que é a garantia real.
        for (const l of g.lines) {
          const result = await tx.product.updateMany({
            where: { id: l.productId, stock: { gte: l.qty } },
            data: { stock: { decrement: l.qty } }
          });
          if (result.count === 0) throw new StockError(`Stock insuficiente para: ${l.name}`);
        }

        if (mode !== 'ENTREGA') {
          await installmentSvc.createPlanTx(tx, {
            order, mode, autoPay,
            count: g.installments ? g.installments.count : 0,
            schedule: g._internal.plan ? g._internal.plan.schedule : null,
            setting: g._internal.plan ? g._internal.plan.setting : null
          });
        }

        createdOrders.push(order);
        sellerGroups[g.sellerId] = g;
      }
    }, { timeout: 25000, maxWait: 10000 });

    // Notificações & emails DEPOIS de responder — não devem atrasar a
    // confirmação da compra. Um SMTP lento (comum, 1-3s por email) não
    // pode ser o que decide quanto tempo o comprador espera pelo "compra
    // confirmada". Erros aqui só vão para o log, nunca para o cliente.
    Promise.all(createdOrders.map(async (order) => {
      const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
      notifSvc.orderReceived(order.sellerId, order.id, order.items.map(i => i.name).join(', '), order.total);
      // Só envia email se o vendedor não o desligou (emailEnabled + orderNotifications).
      if (seller?.email && await notifSvc.shouldEmail(order.sellerId, 'orders')) {
        emailSvc.sendOrderNotificationEmail(seller.email, seller.name, order).catch(() => {});
      }
    })).catch((e) => logger.warn(`[Orders.placeOrder] Falha ao notificar vendedor(es): ${e.message}`));

    // Alertas de stock baixo / esgotado para o vendedor (só quando o stock cruza o limiar).
    for (const g of Object.values(sellerGroups)) {
      for (const l of g.lines) {
        const before = l.product.stock;
        const after = before - l.qty;
        if (after <= 0 && before > 0) {
          notifSvc.push(g.sellerId, {
            type: 'WARNING', title: 'Produto esgotado',
            message: `"${l.name}" ficou sem stock.`, link: `/products/${l.productId}`
          });
        } else if (after > 0 && after <= LOW_STOCK_THRESHOLD && before > LOW_STOCK_THRESHOLD) {
          notifSvc.push(g.sellerId, {
            type: 'WARNING', title: 'Stock baixo',
            message: `"${l.name}" tem apenas ${after} unidade(s) em stock.`, link: `/products/${l.productId}`
          });
        }
      }
    }

    logger.info(`[Orders] ${createdOrders.length} order(s) placed by ${req.user.id} (${mode})`);
    return created(res, { orders: createdOrders, checkout: checkoutSvc.publicQuote(checkout) }, 'Encomenda realizada com sucesso.');
  } catch (err) {
    if (err instanceof StockError) return domainError(res, 400, 'PRODUCT_OUT_OF_STOCK', err.message);
    if (replyKnown(res, err)) return;
    logger.error(`[Orders.placeOrder] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: My orders ─────────────────────────────────────────────
const myOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      buyerId: req.user.id,
      ...(status && { status })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          bazar: { select: { id: true, name: true, slug: true } },
          seller: { select: { id: true, name: true, avatarUrl: true, rating: true } },
          review: true
        }
      }),
      prisma.order.count({ where })
    ]);

    return ok(res, { orders, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Orders.myOrders] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Received orders ──────────────────────────────────────
const sellerOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      sellerId: req.user.id,
      ...(status && { status })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          buyer: { select: { id: true, name: true, phone: true } }
        }
      }),
      prisma.order.count({ where })
    ]);

    return ok(res, { orders, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Orders.sellerOrders] ${err.message}`);
    return serverError(res);
  }
};

// ─── Get single order ─────────────────────────────────────────────
const getOne = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        bazar: { select: { id: true, name: true } },
        buyer: { select: { id: true, name: true, phone: true, email: true } },
        seller: { select: { id: true, name: true, phone: true, email: true } },
        review: true,
        transaction: true,
        statusHistory: { orderBy: { createdAt: 'asc' }, select: { status: true, actorRole: true, note: true, createdAt: true } },
        installmentPlan: { include: { installments: { orderBy: { number: 'asc' } } } },
        dispute: { select: { id: true, status: true, reason: true, createdAt: true } }
      }
    });

    if (!order) return notFound(res, 'Encomenda não encontrada.');
    if (order.buyerId !== req.user.id && order.sellerId !== req.user.id && req.user.role !== 'ADMIN') {
      return forbidden(res);
    }

    return ok(res, { order });
  } catch (err) {
    logger.error(`[Orders.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Update order status ──────────────────────────────────
// Aceita variações comuns do mesmo estado (maiúsculas/minúsculas, espaços, "CANCELADO"/"CANCELLED"…) em
// vez de falhar com "Estado inválido" por uma questão de escrita.
const STATUS_ALIASES = {
  CANCELADO: 'CANCELADA', CANCELED: 'CANCELADA', CANCELLED: 'CANCELADA', CANCEL: 'CANCELADA', CANCELAR: 'CANCELADA',
  ENTREGADO: 'ENTREGUE', DELIVERED: 'ENTREGUE', ACEITO: 'ACEITE', ACCEPTED: 'ACEITE',
  EM_PREPARAÇÃO: 'EM_PREPARACAO', PREPARING: 'EM_PREPARACAO', SHIPPED: 'EM_ENTREGA'
};
const normalizeStatus = (v) => {
  if (typeof v !== 'string') return null;
  const k = v.trim().toUpperCase().replace(/\s+/g, '_');
  return STATUS_ALIASES[k] || k;
};

const updateStatus = async (req, res) => {
  const { cancelReason } = req.body || {};
  const status = normalizeStatus(req.body && req.body.status);
  if (!status || !STATUS_FLOW.includes(status)) {
    // Regista o que chegou de facto — antes só se via "Estado inválido" sem saber porquê.
    logger.warn(`[Orders.updateStatus] estado inválido recebido (order ${req.params.id}, user ${req.user && req.user.id}): ${JSON.stringify(req.body || {}).slice(0, 200)}`);
    return badRequest(res, 'Estado inválido.');
  }

  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return notFound(res);

    const isSeller = order.sellerId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    const isBuyer = order.buyerId === req.user.id;

    if (!isSeller && !isAdmin && !isBuyer) return forbidden(res);

    // Já está no estado pedido (duplo clique em "Cancelar", ou repetição automática do pedido depois
    // de uma ligação lenta): o resultado desejado já existe — responde com sucesso em vez de erro.
    if (order.status === status) return ok(res, { order });

    // A partir daqui, TODOS os atores (incluindo admin) são validados pela
    // mesma máquina de estados — corrige o "admin bypass" que permitia
    // saltar directamente para qualquer estado (ex: PENDENTE → ENTREGUE,
    // ou reabrir uma encomenda já ENTREGUE/CANCELADA).
    if (isTerminal(order.status)) {
      return badRequest(res, 'Esta encomenda já está num estado final e não pode ser alterada.');
    }
    if (!canTransition(order.status, status)) {
      return badRequest(res, `Não é possível mudar de "${order.status}" para "${status}".`);
    }

    // Quem pode fazer o quê (ver utils/orderStateMachine.js):
    //  - comprador: cancelar ANTES de sair para entrega, ou confirmar a entrega;
    //  - vendedor: avançar/cancelar, nunca confirmar a entrega;
    //  - admin: qualquer transição válida (auditada).
    // Precedência mantida: se for comprador (e não admin) aplica-se a regra do comprador.
    const actor = isAdmin ? 'admin' : (isBuyer ? 'buyer' : 'seller');
    const permission = actorMayTransition(actor, order.status, status);
    if (!permission.ok) return forbidden(res, permission.reason);

    // Motivo do cancelamento: texto livre → tipo, tamanho e sanitização.
    if (cancelReason !== undefined && cancelReason !== null && typeof cancelReason !== 'string') {
      return badRequest(res, 'Motivo inválido.');
    }
    const cleanReason = cancelReason ? sanitize(cancelReason).slice(0, 300) : null;

    const updateData = {
      status,
      ...(status === 'CANCELADA' && { cancelledAt: new Date(), cancelReason: cleanReason }),
      ...(status === 'ENTREGUE' && { deliveredAt: new Date() })
    };

    // Claim atómico da transição: só prossegue se `order.status` ainda for
    // exactamente o que lemos acima. Sem isto, dois pedidos concorrentes
    // (duplo clique em "cancelar", ou o comprador a confirmar entrega ao
    // mesmo tempo que o vendedor cancela) podiam ambos passar a verificação
    // síncrona e ambos aplicar os seus efeitos — cancelamento duplo
    // (stock restaurado 2x) ou entrega processada 2x.
    let updated;
    let cancelledPlan = null;
    await prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: updateData
      });
      if (claim.count === 0) throw new InvalidTransitionError();

      // Cronologia (ecrã de acompanhamento da encomenda) — na MESMA transacção do claim
      await tx.orderStatusHistory.create({
        data: { orderId: order.id, status, actorId: req.user.id, actorRole: actor, note: status === 'CANCELADA' ? cleanReason : null }
      });

      // On ENTREGUE: calculate fee, update bazar, create transaction, bump
      // product sales — tudo dentro da MESMA transacção que o claim, para
      // que "ENTREGUE" nunca fique gravado sem os efeitos financeiros
      // correspondentes (e vice-versa).
      if (status === 'ENTREGUE') {
        const [bazar, seller] = await Promise.all([
          tx.bazar.findUnique({ where: { id: order.bazarId } }),
          tx.user.findUnique({ where: { id: order.sellerId }, select: { isPremium: true, premiumExpiresAt: true } })
        ]);
        const sellerPremiumActive = premiumService.isActive(seller);
        // A comissão incide sobre os ARTIGOS (já com desconto), nunca sobre a taxa de entrega.
        const feeBase = Math.max(0, order.total - (order.shippingFee || 0));
        const fee = calcFee(feeBase, premiumService.effectiveFeeRate(bazar?.feeRate || 2, sellerPremiumActive));
        const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
        const itemsLabel = orderItems.map(i => `${i.name} ×${i.qty}`).join(', ') || order.id;

        await tx.order.update({ where: { id: order.id }, data: { feeAmount: fee } });
        await tx.bazar.update({
          where: { id: order.bazarId },
          data: { pendingFees: { increment: fee }, totalSales: { increment: order.total } }
        });
        await tx.transaction.create({
          data: {
            bazarId: order.bazarId,
            orderId: order.id,
            sellerId: order.sellerId,
            type: 'VENDA',
            amount: order.total,
            fee,
            description: `Venda: ${itemsLabel}`
          }
        });
        for (const i of orderItems) {
          await tx.product.update({ where: { id: i.productId }, data: { sales: { increment: i.qty } } });
        }
      }

      // If cancelled: restore stock — também dentro da transacção do
      // claim, para que um cancelamento duplo (que agora é impossível
      // graças ao `claim.count === 0` acima) nunca possa restaurar o
      // mesmo stock duas vezes.
      if (status === 'CANCELADA') {
        // Devolve a utilização do cupão e cancela as parcelas por pagar (o reembolso do que já foi pago
        // é feito DEPOIS do commit — um vendedor sem saldo não pode impedir o cancelamento).
        await couponSvc.revertForOrderTx(tx, order.id);
        cancelledPlan = await installmentSvc.cancelPlanTx(tx, order.id);
        const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
        for (const item of items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.qty } }
          }).catch(() => {}); // Product might have been deleted
        }
        // `cancelCount` mede cancelamentos FEITOS PELO comprador — antes subia também quando era
        // o vendedor (ou o admin) a cancelar, penalizando o comprador por uma decisão alheia.
        if (actor === 'buyer') {
          await tx.user.update({
            where: { id: order.buyerId },
            data: { cancelCount: { increment: 1 } }
          }).catch(() => {});
        }
      }

      updated = await tx.order.findUnique({ where: { id: order.id } });
    });

    // Reembolso do que o comprador já pagou com a carteira (idempotente; fica pendente se o vendedor não tiver saldo)
    if (cancelledPlan && cancelledPlan.planId && cancelledPlan.refundable > 0) {
      await installmentSvc.refundPlan(cancelledPlan.planId, { reason: 'encomenda cancelada' }).catch((e) => logger.error(`[Orders.updateStatus] refund: ${e.message}`));
    }

    // Check fee limit (fora da transacção — leitura informativa, não crítica)
    if (status === 'ENTREGUE') {
      const updatedBazar = await prisma.bazar.findUnique({ where: { id: order.bazarId } });
      if (updatedBazar && updatedBazar.pendingFees >= FEE_LIMIT) {
        notifSvc.feeAlert(order.sellerId, updatedBazar.pendingFees);
        const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
        if (seller) emailSvc.sendFeeAlertEmail(seller.email, seller.name, updatedBazar.pendingFees).catch(() => {});
      }
    }

    // Notificações
    if (actor === 'buyer' && status === 'CANCELADA') {
      // Vendedor: "O comprador cancelou a encomenda" (o stock já foi devolvido)
      notifSvc.push(order.sellerId, {
        type: 'ORDER', title: 'Encomenda cancelada pelo comprador',
        message: `A encomenda #${order.id.slice(-8)} foi cancelada pelo comprador.`,
        link: `order-detail.html?id=${order.id}`
      });
    } else {
      const targetId = actor === 'buyer' ? order.sellerId : order.buyerId;
      notifSvc.orderStatusChanged(targetId, order.id, status);
    }

    // Email ao comprador (só se não o desligou)
    const buyer = await prisma.user.findUnique({ where: { id: order.buyerId }, select: { email: true, name: true } });
    if (buyer && await notifSvc.shouldEmail(order.buyerId, 'orders')) {
      emailSvc.sendOrderStatusEmail(buyer.email, buyer.name, order, status).catch(() => {});
    }

    // Admin a intervir numa encomenda que não é sua: fica no AuditLog.
    if (actor === 'admin' && !isSeller && !isBuyer) {
      audit.record(req, 'ADMIN_ORDER_STATUS_OVERRIDE', {
        entity: 'Order', entityId: order.id,
        oldValue: { status: order.status }, newValue: { status, ...(cleanReason && { reason: cleanReason }) }
      });
    }

    eventBus.emit(eventBus.EVENTS.ORDER_STATUS_CHANGED, {
      orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, status, from: order.status
    });

    logger.info(`[Orders] Status updated: ${order.id} → ${status} by ${req.user.id}`);
    return ok(res, { order: updated }, `Encomenda ${status.toLowerCase()}.`);
  } catch (err) {
    if (err instanceof InvalidTransitionError) return badRequest(res, err.message);
    logger.error(`[Orders.updateStatus] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: Submit review ─────────────────────────────────────────
const submitReview = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  // Aceitar rating como string, número ou float
  const rating = parseInt(req.body?.rating ?? req.body?.stars ?? req.body?.score);
  const comment = req.body?.comment || req.body?.text || req.body?.message || null;

  if (!rating || rating < 1 || rating > 5) {
    return badRequest(res, 'Avaliação inválida. Escolha entre 1 e 5 estrelas.');
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true }
    });

    if (!order) return notFound(res, 'Encomenda não encontrada.');
    if (order.buyerId !== req.user.id) return forbidden(res);
    if (order.status !== 'ENTREGUE') return badRequest(res, 'Só pode avaliar encomendas já entregues.');

    // Verificar duplicado directamente na tabela Review (mais fiável que order.rated)
    const existing = await prisma.review.findUnique({ where: { orderId: order.id } });
    if (existing || order.rated) return badRequest(res, 'Esta encomenda já foi avaliada.');

    // A Review é uma por encomenda (Review.orderId é @unique no schema —
    // mudar isto para "uma review por produto" é uma decisão de produto
    // que implica também redesenhar o formulário no frontend, por isso
    // não a fiz sozinho aqui). Guardamos a review "principal" contra o
    // primeiro produto (como antes), mas agora actualizamos a média de
    // TODOS os produtos da encomenda — antes só o primeiro produto via
    // o seu rating actualizado, e os restantes artigos da mesma
    // encomenda ficavam de fora do cálculo para sempre.
    const productIds = [...new Set(order.items.map(i => i.productId))];
    const productId = productIds[0];
    if (!productId) return badRequest(res, 'Produto não encontrado na encomenda.');

    await prisma.$transaction(async (tx) => {
      // Create review
      await tx.review.create({
        data: {
          orderId: order.id,
          productId,
          sellerId: order.sellerId,
          buyerId: req.user.id,
          rating: parseInt(rating),
          comment: comment ? sanitize(comment) : null
        }
      });

      // Mark order as rated
      await tx.order.update({ where: { id: order.id }, data: { rated: true } });

      // Recalculate seller rating — usar aggregate() para a BD calcular a
      // média directamente, em vez de carregar TODAS as reviews do vendedor
      // para a memória do Node só para somar. Com um vendedor popular (milhares
      // de reviews), a versão antiga ficava mais lenta a cada review nova, e
      // mantinha a transacção (e a ligação à BD) aberta cada vez mais tempo.
      const sellerAgg = await tx.review.aggregate({
        where: { sellerId: order.sellerId },
        _avg: { rating: true },
        _count: true
      });
      await tx.user.update({
        where: { id: order.sellerId },
        data: { rating: Math.round((sellerAgg._avg.rating || 0) * 10) / 10, ratingCount: sellerAgg._count }
      });

      // Recalculate product rating (mesma razão de performance do
      // aggregate acima). NOTA: a Review só está ligada a UM produto
      // (productId = primeiro item da encomenda) — actualizar a média
      // dos restantes produtos exigiria uma Review por produto, o que
      // implica mudar o schema (unique constraint) e o formulário do
      // frontend. Não fiz essa mudança sozinho; ver aviso separado.
      const productAgg = await tx.review.aggregate({
        where: { productId },
        _avg: { rating: true },
        _count: true
      });
      await tx.product.update({
        where: { id: productId },
        data: { rating: Math.round((productAgg._avg.rating || 0) * 10) / 10, ratingCount: productAgg._count }
      });
    });

    notifSvc.push(order.sellerId, {
      type: 'REVIEW',
      title: 'Nova avaliação recebida',
      message: `Recebeu uma avaliação de ${rating} estrela${rating !== 1 ? 's' : ''}.`,
      link: '/profile'
    });

    return created(res, {}, 'Avaliação enviada. Obrigado!');
  } catch (err) {
    logger.error(`[Orders.submitReview] ${err.message}`);
    // P2002 em orderId: um pedido concorrente (duplo toque em "Enviar
    // avaliação") já criou a review entre a verificação acima e o create.
    if (err.code === 'P2002') return badRequest(res, 'Esta encomenda já foi avaliada.');
    return serverError(res);
  }
};

module.exports = { placeOrder, myOrders, sellerOrders, getOne, updateStatus, submitReview };



