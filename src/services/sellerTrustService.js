'use strict';

/**
 * Confiança do vendedor — informativa, NUNCA limita nada (conta única: qualquer pessoa vende
 * desde o primeiro dia). Calculada com dados reais: encomendas entregues/canceladas, avaliações
 * e respostas do vendedor às avaliações.
 *
 * Níveis: NOVO · BOM · EXCELENTE · ATENCAO (só o próprio vendedor vê ATENCAO, com dicas).
 */
const { createTtlCache } = require('../utils/ttlCache');

const cache = createTtlCache({ ttlMs: 5 * 60 * 1000, max: 1000 });
const prisma = () => require('../config/database');

const LABELS = { NOVO: 'Vendedor novo', BOM: 'Vendedor de confiança', EXCELENTE: 'Vendedor de excelência', ATENCAO: 'Precisa de atenção' };

// Função pura (testável): decide o nível a partir das métricas.
function computeLevel({ delivered, cancelled, ratingAvg, ratingCount }) {
  const finished = delivered + cancelled;
  const cancelRate = finished > 0 ? cancelled / finished : 0;
  if ((ratingCount >= 5 && ratingAvg < 3) || (finished >= 10 && cancelRate > 0.4)) return 'ATENCAO';
  if (delivered < 3) return 'NOVO';
  if (delivered >= 20 && ratingCount >= 5 && ratingAvg >= 4.5 && cancelRate <= 0.1) return 'EXCELENTE';
  return 'BOM';
}

function tipsFor({ delivered, cancelled, ratingAvg, ratingCount, replyRate, level }) {
  const tips = [];
  const finished = delivered + cancelled;
  if (finished > 0 && cancelled / finished > 0.2) tips.push('Muitas encomendas canceladas: responde depressa e actualiza o stock para evitar cancelamentos.');
  if (ratingCount >= 3 && ratingAvg < 4) tips.push('A avaliação média está abaixo de 4: confirma descrições, fotos e prazos de entrega.');
  if (ratingCount > 0 && replyRate < 0.5) tips.push('Responde às avaliações dos clientes — mostra que és um vendedor atento.');
  if (level === 'NOVO') tips.push('Completa as tuas primeiras 3 entregas para ganhares o selo de confiança.');
  return tips;
}

async function trustSummary(sellerId) {
  return cache.wrap(`trust:${sellerId}`, async () => {
    const db = prisma();
    const [delivered, cancelled, agg, replied] = await Promise.all([
      db.order.count({ where: { sellerId, status: 'ENTREGUE' } }),
      db.order.count({ where: { sellerId, status: 'CANCELADA' } }),
      db.review.aggregate({ where: { sellerId }, _avg: { rating: true }, _count: { _all: true } }),
      db.review.count({ where: { sellerId, sellerReply: { not: null } } })
    ]);
    const ratingCount = agg._count._all;
    const ratingAvg = ratingCount ? Math.round(agg._avg.rating * 10) / 10 : 0;
    const finished = delivered + cancelled;
    const m = {
      delivered, cancelled, ratingAvg, ratingCount,
      cancelRate: finished ? Math.round((cancelled / finished) * 100) / 100 : 0,
      replyRate: ratingCount ? Math.round((replied / ratingCount) * 100) / 100 : 0
    };
    const level = computeLevel(m);
    return { ...m, level, label: LABELS[level], tips: tipsFor({ ...m, level }) };
  });
}

// Versão pública: nunca expõe "ATENCAO" nem dicas (isso é só para o dono).
const toPublic = (s) => ({
  level: s.level === 'ATENCAO' ? 'NORMAL' : s.level,
  badge: s.level === 'ATENCAO' ? null : s.label,
  delivered: s.delivered, ratingAvg: s.ratingAvg, ratingCount: s.ratingCount
});

// Compatibilidade: quota de anúncios continua a ser sempre "sem limite" (conta única).
async function productQuota() {
  return { trusted: true, limit: null, active: 0, delivered: 0 };
}

module.exports = { trustSummary, toPublic, computeLevel, productQuota, PRODUCT_LIMIT: null, MIN_DELIVERED: 0 };
