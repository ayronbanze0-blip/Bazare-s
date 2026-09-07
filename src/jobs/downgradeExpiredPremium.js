'use strict';

// ─────────────────────────────────────────────────────────────────
// O projecto já tinha um "lazy downgrade" (premiumService.downgradeIfExpired)
// chamado em login/getMe — mas isso só corrige o próprio utilizador quando
// ELE faz um desses pedidos. Entretanto, várias listagens públicas
// (productController "novo" sort, searchController, ranking do bazar)
// ordenam directamente por `seller.isPremium` sem passar por
// premiumService.isActive — por isso um vendedor cujo Premium expirou
// continuava a aparecer com prioridade de Premium até ele próprio fazer
// login de novo.
//
// Este job corre em lote periodicamente e rebaixa TODOS os utilizadores
// cujo premiumExpiresAt já passou, para que `isPremium` na BD fique
// consistente para essas queries também — sem precisar de reescrever
// cada orderBy para usar premiumExpiresAt directamente.
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');

async function downgradeExpiredPremium(prisma) {
  try {
    const result = await prisma.user.updateMany({
      where: { isPremium: true, premiumExpiresAt: { lt: new Date() } },
      data: { isPremium: false }
    });
    if (result.count > 0) {
      logger.info(`[downgradeExpiredPremium] ${result.count} conta(s) Premium expirada(s) rebaixada(s).`);
    }
  } catch (err) {
    logger.error(`[downgradeExpiredPremium] ${err.message}`);
  }
}

function schedulePremiumDowngrade(prisma, intervalMs = 15 * 60 * 1000) {
  setTimeout(() => downgradeExpiredPremium(prisma), 20 * 1000);
  return setInterval(() => downgradeExpiredPremium(prisma), intervalMs);
}

module.exports = { downgradeExpiredPremium, schedulePremiumDowngrade };
