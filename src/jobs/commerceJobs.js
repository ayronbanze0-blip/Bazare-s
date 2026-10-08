'use strict';

/**
 * Jobs da Fase 5 (agendados no arranque, seguros para várias instâncias — cada passo usa "claims" atómicos):
 *   - parcelas: avisos, débito automático, multas, incumprimento, reembolsos pendentes (cada 30 min)
 *   - promoções terminadas e limpeza de visualizações antigas (cada hora)
 * Um passo que falha nunca impede os outros nem derruba o processo.
 */
const logger = require('../utils/logger');

const safe = (label, fn) => async () => {
  try { await fn(); } catch (err) { logger.error(`[commerceJobs:${label}] ${err.message}`); }
};

function scheduleCommerceJobs() {
  // require lazy: o ficheiro continua importável em testes sem BD
  const installments = () => require('../services/installmentService').runInstallmentJob();
  const promotions = () => require('../services/couponService').expirePromotions();
  const views = () => require('../services/viewService').maintenance();

  const runInstallments = safe('installments', installments);
  const runHourly = async () => { await safe('promotions', promotions)(); await safe('views', views)(); };

  const timers = [
    setTimeout(runInstallments, 45 * 1000),
    setTimeout(runHourly, 90 * 1000),
    setInterval(runInstallments, 30 * 60 * 1000),
    setInterval(runHourly, 60 * 60 * 1000)
  ];
  timers.forEach((t) => t.unref && t.unref());
  return timers;
}

module.exports = { scheduleCommerceJobs };
