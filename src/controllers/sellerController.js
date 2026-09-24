'use strict';

const prisma = require('../config/database');
const { ok, forbidden, notFound, badRequest, serverError } = require('../utils/response');
const logger = require('../utils/logger');
const analytics = require('../services/analyticsService');
const { summarizeHealth } = require('../services/productHealth');

const isValidId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

// ─── GET /api/seller/dashboard?period=today|7d|30d|90d|all ─────────
// Números do PRÓPRIO vendedor (req.user.id). Nunca aceita um sellerId vindo do cliente.
const dashboard = async (req, res) => {
  try {
    const range = analytics.periodRange(req.query.period);
    const data = await analytics.sellerDashboard(prisma, req.user.id, range);
    return ok(res, data);
  } catch (err) {
    logger.error(`[Seller.dashboard] ${err.message}`);
    return serverError(res, 'Não foi possível carregar o dashboard.');
  }
};

// Analytics de UM produto. `allowAdmin`:
//   true  → GET /api/products/:id/analytics        (vendedor dono OU admin)
//   false → GET /api/seller/products/:id/analytics (só o vendedor dono)
// Só devolve totais — nunca dados de compradores.
const productAnalyticsFor = ({ allowAdmin }) => async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badRequest(res, 'Produto inválido.');
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, sellerId: true, views: true }
    });
    if (!product) return notFound(res, 'Produto não encontrado.');

    const isOwner = product.sellerId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';
    if (!isOwner && !(allowAdmin && isAdmin)) return forbidden(res, 'Sem permissão para ver os analytics deste produto.');

    const { period, since } = analytics.periodRange(req.query.period);
    const metrics = await analytics.productMetrics(prisma, product, since);
    return ok(res, { name: product.name, period, ...metrics });
  } catch (err) {
    logger.error(`[Seller.productAnalytics] ${err.message}`);
    return serverError(res, 'Não foi possível carregar os analytics do produto.');
  }
};

// ─── GET /api/seller/products/health ─────────────────────────────
// Recomendações para os PRÓPRIOS produtos (sem imagem, sem descrição, sem stock, preço inválido…).
const productsHealth = async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { sellerId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: {
        id: true, name: true, description: true, price: true, category: true, stock: true, active: true,
        _count: { select: { images: true } }
      }
    });
    return ok(res, summarizeHealth(products));
  } catch (err) {
    logger.error(`[Seller.productsHealth] ${err.message}`);
    return serverError(res);
  }
};

module.exports = {
  dashboard,
  productAnalyticsOwner: productAnalyticsFor({ allowAdmin: false }),
  productAnalyticsOwnerOrAdmin: productAnalyticsFor({ allowAdmin: true }),
  productsHealth
};
