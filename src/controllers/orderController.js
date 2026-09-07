'use strict';

const { validationResult } = require('express-validator');

const { ok, created, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, calcFee, parseLatLng, sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const emailSvc = require('../services/emailService');
const premiumService = require('../services/premiumService');
const logger = require('../utils/logger');
const { canTransition, isTerminal } = require('../utils/orderStateMachine');

const prisma = require('../config/database');

const FEE_LIMIT_PARSED = parseFloat(process.env.FEE_LIMIT_MT);
const FEE_LIMIT = Number.isFinite(FEE_LIMIT_PARSED) ? FEE_LIMIT_PARSED : 150;
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

// ─── BUYER: Place order ───────────────────────────────────────────
const placeOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  const { items, buyerName, buyerPhone, address, latitude, longitude, payment, size, color, notes } = req.body;
  const geo = parseLatLng(latitude, longitude);

  if (!items || !items.length) return badRequest(res, 'Nenhum item na encomenda.');

  try {
    // Validate all items and group by seller
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
      include: { bazar: true, images: { take: 1, orderBy: { order: 'asc' } } }
    });

    if (products.length !== productIds.length)
      return badRequest(res, 'Um ou mais produtos não estão disponíveis.');

    // Check stock
    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      if (!product) return badRequest(res, `Produto ${item.productId} não encontrado.`);
      if (product.stock < item.qty) return badRequest(res, `Stock insuficiente para: ${product.name}`);
      if (item.qty < 1) return badRequest(res, `Quantidade inválida para: ${product.name}`);
    }

    // Group items by seller (one order per seller)
    const sellerGroups = {};
    for (const item of items) {
      const product = products.find(p => p.id === item.productId);
      const sid = product.sellerId;
      if (!sellerGroups[sid]) sellerGroups[sid] = { sellerId: sid, bazar: product.bazar, items: [] };
      sellerGroups[sid].items.push({ product, qty: item.qty });
    }

    const createdOrders = [];

    // Uma única query para saber quais destes vendedores têm Premium
    // activo — usado para aplicar a taxa reduzida (ver premiumService).
    const sellerIds = Object.keys(sellerGroups);
    const premiumSellers = await prisma.user.findMany({
      where: { id: { in: sellerIds }, isPremium: true },
      select: { id: true, premiumExpiresAt: true }
    });
    const premiumSellerIds = new Set(
      premiumSellers
        .filter(u => u.premiumExpiresAt && new Date(u.premiumExpiresAt) > new Date())
        .map(u => u.id)
    );

    await prisma.$transaction(async (tx) => {
      for (const group of Object.values(sellerGroups)) {
        const subtotal = group.items.reduce((s, i) => s + i.product.price * i.qty, 0);
        const baseFeeRate = group.bazar.feeRate || 2;
        const feeRate = premiumService.effectiveFeeRate(baseFeeRate, premiumSellerIds.has(group.sellerId));
        const feeAmount = calcFee(subtotal, feeRate);

        const order = await tx.order.create({
          data: {
            buyerId: req.user.id,
            sellerId: group.sellerId,
            bazarId: group.bazar.id,
            buyerName: buyerName || req.user.name,
            buyerPhone,
            address,
            latitude: geo?.latitude ?? null,
            longitude: geo?.longitude ?? null,
            payment: payment || 'Pagamento na entrega',
            size: size || null,
            color: color || null,
            notes: notes || null,
            subtotal,
            feeRate,
            feeAmount,
            total: subtotal,
            items: {
              create: group.items.map(i => ({
                productId: i.product.id,
                name: i.product.name,
                price: i.product.price,
                qty: i.qty,
                // Guarda a imagem principal no momento da compra para
                // histórico imutável (mesmo que o produto seja apagado depois)
                imageUrl: i.product.images?.[0]?.url || null
              }))
            }
          },
          include: { items: true }
        });

        // Decrement stock atomically: só decrementa se o stock disponível
        // neste preciso momento (dentro da transacção) ainda for suficiente.
        // Isto evita overselling quando dois pedidos concorrentes disputam
        // o mesmo produto — a pré-checagem acima pode estar desactualizada
        // por essa altura, esta é que é a garantia real.
        for (const i of group.items) {
          const result = await tx.product.updateMany({
            where: { id: i.product.id, stock: { gte: i.qty } },
            data: { stock: { decrement: i.qty } }
          });
          if (result.count === 0) {
            throw new StockError(`Stock insuficiente para: ${i.product.name}`);
          }
        }

        createdOrders.push(order);
      }
    });

    // Notificações & emails DEPOIS de responder — não devem atrasar a
    // confirmação da compra. Um SMTP lento (comum, 1-3s por email) não
    // pode ser o que decide quanto tempo o comprador espera pelo "compra
    // confirmada". Erros aqui só vão para o log, nunca para o cliente.
    Promise.all(createdOrders.map(async (order) => {
      const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
      notifSvc.orderReceived(order.sellerId, order.id, order.items.map(i => i.name).join(', '), order.total);
      if (seller?.email) {
        emailSvc.sendOrderNotificationEmail(seller.email, seller.name, order).catch(() => {});
      }
    })).catch((e) => logger.warn(`[Orders.placeOrder] Falha ao notificar vendedor(es): ${e.message}`));

    logger.info(`[Orders] ${createdOrders.length} order(s) placed by ${req.user.email}`);
    return created(res, { orders: createdOrders }, 'Encomenda realizada com sucesso.');
  } catch (err) {
    if (err instanceof StockError) return badRequest(res, err.message);
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
        transaction: true
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
const updateStatus = async (req, res) => {
  const { status, cancelReason } = req.body;
  if (!status || !STATUS_FLOW.includes(status)) return badRequest(res, 'Estado inválido.');

  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return notFound(res);

    const isSeller = order.sellerId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    const isBuyer = order.buyerId === req.user.id;

    if (!isSeller && !isAdmin && !isBuyer) return forbidden(res);

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

    // Buyers can only confirm delivery
    if (isBuyer && !isAdmin) {
      if (status !== 'ENTREGUE') return forbidden(res, 'Compradores só podem confirmar entrega.');
    }

    // Sellers cannot go backwards in flow, and cannot confirm ENTREGUE
    // themselves — só o comprador (ou admin) pode confirmar que o artigo
    // chegou.
    if (isSeller && !isAdmin) {
      if (status === 'ENTREGUE') return forbidden(res, 'Apenas o comprador pode confirmar a entrega.');
    }

    const updateData = {
      status,
      ...(status === 'CANCELADA' && { cancelledAt: new Date(), cancelReason: cancelReason || null }),
      ...(status === 'ENTREGUE' && { deliveredAt: new Date() })
    };

    // Claim atómico da transição: só prossegue se `order.status` ainda for
    // exactamente o que lemos acima. Sem isto, dois pedidos concorrentes
    // (duplo clique em "cancelar", ou o comprador a confirmar entrega ao
    // mesmo tempo que o vendedor cancela) podiam ambos passar a verificação
    // síncrona e ambos aplicar os seus efeitos — cancelamento duplo
    // (stock restaurado 2x) ou entrega processada 2x.
    let updated;
    await prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: updateData
      });
      if (claim.count === 0) throw new InvalidTransitionError();

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
        const fee = calcFee(order.total, premiumService.effectiveFeeRate(bazar?.feeRate || 2, sellerPremiumActive));
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
        const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
        for (const item of items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.qty } }
          }).catch(() => {}); // Product might have been deleted
        }
        await tx.user.update({
          where: { id: order.buyerId },
          data: { cancelCount: { increment: 1 } }
        }).catch(() => {});
      }

      updated = await tx.order.findUnique({ where: { id: order.id } });
    });

    // Check fee limit (fora da transacção — leitura informativa, não crítica)
    if (status === 'ENTREGUE') {
      const updatedBazar = await prisma.bazar.findUnique({ where: { id: order.bazarId } });
      if (updatedBazar && updatedBazar.pendingFees >= FEE_LIMIT) {
        notifSvc.feeAlert(order.sellerId, updatedBazar.pendingFees);
        const seller = await prisma.user.findUnique({ where: { id: order.sellerId } });
        if (seller) emailSvc.sendFeeAlertEmail(seller.email, seller.name, updatedBazar.pendingFees).catch(() => {});
      }
    }

    // Notifications
    const targetId = isBuyer ? order.sellerId : order.buyerId;
    notifSvc.orderStatusChanged(targetId, order.id, status);

    // Email notifications
    const buyer = await prisma.user.findUnique({ where: { id: order.buyerId }, select: { email: true, name: true } });
    if (buyer) emailSvc.sendOrderStatusEmail(buyer.email, buyer.name, order, status).catch(() => {});

    logger.info(`[Orders] Status updated: ${order.id} → ${status} by ${req.user.email}`);
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



