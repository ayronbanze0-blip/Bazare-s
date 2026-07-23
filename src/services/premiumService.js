'use strict';

/**
 * Premium Service — regras de negócio da Conta Premium.
 *
 * Plano único, mensal, cobrado por STK push (ZumboPay). O "estado
 * actual" de premium de um utilizador vive em User.isPremium +
 * User.premiumExpiresAt; a tabela PremiumSubscription é só o histórico
 * de tentativas de pagamento (um registo por ciclo/tentativa), no
 * mesmo espírito de CommissionPayment para a comparticipação de taxas.
 *
 * PREMIUM_PRICE_MT — preço mensal em Meticais. Ajustável via variável
 * de ambiente no Render sem precisar de novo deploy.
 * PREMIUM_FEE_RATE — taxa de comissão (%) aplicada a vendedores Premium,
 * em vez do feeRate normal do bazar (2% por defeito). Só é aplicada
 * quando é mais baixa que a feeRate actual do bazar, para não subir
 * a taxa de um bazar que já negociou algo melhor com o admin.
 */

const logger = require('../utils/logger');

const PREMIUM_PRICE_MT = parseFloat(process.env.PREMIUM_PRICE_MT) || 500;
const PREMIUM_FEE_RATE = parseFloat(process.env.PREMIUM_FEE_RATE) || 1.0;
const PREMIUM_PERIOD_DAYS = 30;

// ─── Estado efectivo de premium (fonte de verdade = premiumExpiresAt) ─
// Um user.isPremium=true "stale" (expirou mas ainda não foi rebaixado
// na BD) nunca deve ser tratado como premium activo pelo resto do
// código — todas as leituras devem passar por aqui, não ler
// isPremium directamente.
const isActive = (user) => {
  if (!user || !user.isPremium) return false;
  if (!user.premiumExpiresAt) return false;
  return new Date(user.premiumExpiresAt).getTime() > Date.now();
};

// ─── Lazy downgrade: chamado nos pontos de leitura mais comuns (login,
// getMe) para rebaixar contas cujo período expirou sem precisar de um
// cron job — o projecto não tem worker separado, corre tudo no mesmo
// processo web do Render. ────────────────────────────────────────────
const downgradeIfExpired = async (prisma, user) => {
  if (!user || !user.isPremium) return user;
  if (user.premiumExpiresAt && new Date(user.premiumExpiresAt).getTime() > Date.now()) return user;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { isPremium: false }
  });
  logger.info(`[Premium] Assinatura expirada — ${user.id} rebaixado para conta normal.`);
  return updated;
};

// ─── Activa/estende o período premium por +30 dias a partir de hoje,
// ou a partir do fim do período actual se ainda estiver activo (para
// não perder dias já pagos ao renovar antes do fim). ─────────────────
const activateOrExtend = async (tx, userId) => {
  const user = await tx.user.findUnique({ where: { id: userId } });
  const now = new Date();
  const base = (user.isPremium && user.premiumExpiresAt && new Date(user.premiumExpiresAt) > now)
    ? new Date(user.premiumExpiresAt)
    : now;
  const periodEnd = new Date(base.getTime() + PREMIUM_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  await tx.user.update({
    where: { id: userId },
    data: {
      isPremium: true,
      premiumSince: user.premiumSince || now,
      premiumExpiresAt: periodEnd
    }
  });

  return periodEnd;
};

const effectiveFeeRate = (bazarFeeRate, sellerIsPremiumActive) => {
  if (!sellerIsPremiumActive) return bazarFeeRate;
  return Math.min(bazarFeeRate, PREMIUM_FEE_RATE);
};

// ─── Melhorador de fotografias (Premium) ───────────────────────────
// Não reprocessamos nem re-hospedamos nada — a Cloudinary já guarda a
// imagem original; isto só constrói o mesmo URL com um conjunto de
// transformações automáticas (melhoria de cor/contraste, nitidez,
// upscale ligeiro, compressão inteligente) inseridas no caminho.
// A Cloudinary gera a versão transformada on-demand na primeira vez
// que o URL é pedido, e fica em cache a partir daí — sem custo de
// armazenamento extra nem chamada a outra API.
const ENHANCE_TRANSFORM = 'e_improve,e_auto_contrast,e_sharpen:60,q_auto,f_auto';

const buildEnhancedPhotoUrl = (originalUrl) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName || !originalUrl) return null;
  const marker = `res.cloudinary.com/${cloudName}/image/upload/`;
  const idx = originalUrl.indexOf(marker);
  if (idx === -1) return null; // não é uma imagem hospedada na nossa conta Cloudinary
  const before = originalUrl.slice(0, idx + marker.length);
  let after = originalUrl.slice(idx + marker.length);
  // Se já houver uma transformação nossa aplicada (ex: pedido em duplicado),
  // não empilha — substitui.
  if (after.startsWith(ENHANCE_TRANSFORM + '/')) return originalUrl;
  return `${before}${ENHANCE_TRANSFORM}/${after}`;
};

module.exports = {
  PREMIUM_PRICE_MT,
  PREMIUM_FEE_RATE,
  PREMIUM_PERIOD_DAYS,
  isActive,
  downgradeIfExpired,
  activateOrExtend,
  effectiveFeeRate,
  buildEnhancedPhotoUrl
};
