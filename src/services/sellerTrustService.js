'use strict';

// Conta única: qualquer utilizador pode abrir uma loja. A barreira de risco fica
// no volume de anúncios de lojas novas, que sobe quando a loja ganha confiança:
//   · selo de verificado (pedido pelo vendedor, aprovado pelo admin),
//   · conta Premium activa, ou
//   · vendas concluídas (encomendas ENTREGUE) suficientes.
// Configurável por ambiente, sem migração.
const prisma = require('../config/database');
const premiumService = require('./premiumService');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const PRODUCT_LIMIT = num(process.env.NEW_SELLER_PRODUCT_LIMIT, 10);
const MIN_DELIVERED = num(process.env.NEW_SELLER_MIN_DELIVERED, 3);

/**
 * Devolve { trusted, limit, active, delivered } para um vendedor.
 * `trusted` = sem limite de anúncios activos.
 */
async function productQuota(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, verifiedSeller: true, isPremium: true, premiumExpiresAt: true }
  });
  if (!user) return { trusted: false, limit: PRODUCT_LIMIT, active: 0, delivered: 0 };
  if (user.role === 'ADMIN' || user.verifiedSeller || premiumService.isActive(user)) {
    return { trusted: true, limit: null, active: 0, delivered: 0 };
  }
  const [delivered, active] = await Promise.all([
    prisma.order.count({ where: { sellerId: userId, status: 'ENTREGUE' } }),
    prisma.product.count({ where: { sellerId: userId, active: true } })
  ]);
  return { trusted: delivered >= MIN_DELIVERED, limit: PRODUCT_LIMIT, active, delivered };
}

module.exports = { productQuota, PRODUCT_LIMIT, MIN_DELIVERED };
