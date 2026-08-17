'use strict';

const { ok, badRequest, forbidden, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const aiSvc = require('../services/aiService');
const premiumService = require('../services/premiumService');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── POST /api/ai/generate-caption ─────────────────────────────────
// Legenda genérica para Stories, Reels e Anúncios — mesma ideia do
// "Gerar descrição com IA" dos produtos, mas sem exigir nome/categoria
// de produto. Não grava nada, só devolve texto para o vendedor rever
// antes de publicar.
const generateCaption = async (req, res) => {
  try {
    const { kind, keywords } = req.body;
    const validKinds = ['STORY', 'REEL', 'ANNOUNCEMENT'];
    if (!validKinds.includes(kind)) return badRequest(res, 'Tipo de publicação inválido.');

    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id }, select: { name: true } });

    const result = await aiSvc.generateCaption({
      kind,
      storeName: bazar?.name || 'a minha loja',
      keywords: keywords ? sanitize(keywords) : ''
    });

    if (!result.ok) return badRequest(res, result.error || 'Não foi possível gerar a legenda.');
    return ok(res, { caption: result.caption });
  } catch (err) {
    logger.error(`[AI.generateCaption] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { generateCaption };
