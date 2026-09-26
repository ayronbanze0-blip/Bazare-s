'use strict';

/**
 * GET /api/content/:targetType/:targetId
 *
 * Leitor UNIFICADO de conteúdo (secção 8 do documento de arquitectura):
 * devolve PRODUCT, ANNOUNCEMENT (Post) ou REEL no mesmo formato comum
 * { id, type, author, bazar, media, caption, product, engagement },
 * sem migrar o schema — só normaliza o que os controllers existentes já
 * devolvem. É a versão sem risco do "Content" do documento: aditiva,
 * não mexe nas tabelas, não obriga o frontend a mudar nada do que já usa
 * /products/:id, /bazars/:idOrSlug/posts, etc.
 *
 * STORY fica de fora de propósito: no schema actual uma história só se lê
 * sozinha pelo dono (storyController.getOne exige ser o vendedor) — não
 * existe uma leitura pública de UMA história isolada, só a lista agrupada
 * por bazar. Adicionar isso seria uma decisão de produto (mostrar
 * histórias fora da sequência/expiração normal), não só uma normalização.
 */

const { ok, badRequest, notFound, serverError } = require('../utils/response');
const { internalCall } = require('../services/internalCall');
const productCtrl = require('./productController');
const browse = require('./browseController');
const logger = require('../utils/logger');

const TYPES = ['PRODUCT', 'ANNOUNCEMENT', 'REEL'];

const normalize = (targetType, data) => {
  if (targetType === 'PRODUCT') {
    const p = data.product;
    return {
      id: p.id, type: 'PRODUCT', author: null, bazar: p.bazar || null,
      media: (p.images || []).map((i) => i.url || i), caption: p.description || p.name,
      product: { id: p.id, name: p.name, price: p.price, slug: p.slug },
      engagement: { likeCount: p.likeCount, commentCount: p.commentCount, savedByMe: p.isFavorite }
    };
  }
  if (targetType === 'ANNOUNCEMENT') {
    const post = data.post;
    return {
      id: post.id, type: 'POST', author: { id: post.sellerId }, bazar: post.bazar || null,
      media: (post.images || []).map((i) => i.url || i), caption: post.text,
      product: post.product || null,
      engagement: { likeCount: post.likeCount, commentCount: post.commentCount, shareCount: post.shareCount, savedByMe: post.savedByMe }
    };
  }
  const reel = data.reel;
  return {
    id: reel.id, type: 'REEL', author: { id: reel.sellerId }, bazar: reel.bazar || null,
    media: (reel.images || []).map((i) => i.url || i), caption: reel.caption || null,
    product: reel.product || null,
    engagement: { likeCount: reel.likeCount, commentCount: reel.commentCount, shareCount: reel.shareCount, savedByMe: reel.savedByMe }
  };
};

// ─── GET /api/content/:targetType/:targetId ───────────────────────
const getOne = async (req, res) => {
  try {
    const targetType = (req.params.targetType || '').toUpperCase();
    if (!TYPES.includes(targetType)) return badRequest(res, 'Tipo inválido. Use PRODUCT, ANNOUNCEMENT ou REEL.');

    const c = { user: req.user, id: req.id, headers: req.headers };
    const handler = targetType === 'PRODUCT' ? productCtrl.getOne
      : targetType === 'ANNOUNCEMENT' ? browse.postOne
      : browse.reelOne;

    const result = await internalCall(handler, c, { params: { id: req.params.targetId } });
    if (!result.ok) return result.status === 404 ? notFound(res, 'Conteúdo não encontrado.') : serverError(res);

    return ok(res, { content: normalize(targetType, result.data) });
  } catch (err) {
    logger.error(`[Content.getOne] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { getOne };
