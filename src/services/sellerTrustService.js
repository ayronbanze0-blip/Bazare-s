'use strict';

// CONTA ÚNICA, SEM LIMITES: já não existe quota de anúncios para lojas novas.
// Qualquer pessoa publica quantos produtos quiser desde o primeiro dia.
// O ficheiro fica só para não partir quem ainda o importe; devolve sempre
// "sem limite". (Antes: NEW_SELLER_PRODUCT_LIMIT / NEW_SELLER_MIN_DELIVERED.)

async function productQuota() {
  return { trusted: true, limit: null, active: 0, delivered: 0 };
}

module.exports = { productQuota, PRODUCT_LIMIT: null, MIN_DELIVERED: 0 };
