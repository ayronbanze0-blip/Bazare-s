'use strict';

/**
 * Camada de EXPERIÊNCIA — um pedido por ecrã, em vez de 8–10 em sequência.
 *   GET /api/home
 *   GET /api/explore
 *   GET /api/products/:id/view
 *   GET /api/bazars/:idOrSlug/view
 * Só agrega: reutiliza os controllers existentes (internalCall), por isso
 * herda bloqueios, moderação, favoritos e engagement sem os duplicar.
 * Cada secção é independente (allSettled): se uma falhar, vem vazia.
 */

const { ok, notFound, serverError } = require('../utils/response');
const { internalCall, pick } = require('../services/internalCall');
const productCtrl = require('./productController');
const bazarCtrl = require('./bazarController');
const reelCtrl = require('./reelController');
const storyCtrl = require('./storyController');
const feedCtrl = require('./feedController');
const announcementCtrl = require('./announcementController');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const ctx = (req) => ({ user: req.user, id: req.id, headers: req.headers });

// ─── GET /api/home ────────────────────────────────────────────────
const home = async (req, res) => {
  try {
    const c = ctx(req);
    const [stories, feed, reels, featured, fresh, bazars, cats] = await Promise.allSettled([
      internalCall(storyCtrl.list, c),
      internalCall(feedCtrl.list, c, { query: { limit: 10 } }),
      internalCall(reelCtrl.listGlobal, c, { query: { limit: 8 } }),
      internalCall(productCtrl.featured, c),
      internalCall(productCtrl.list, c, { query: { sort: 'new', limit: 12 } }),
      internalCall(bazarCtrl.list, c, { query: { limit: 10 } }),
      internalCall(productCtrl.categoriesOverview, c)
    ]);
    const feedData = feed.status === 'fulfilled' && feed.value.ok ? feed.value.data : null;
    return ok(res, {
      stories: pick(stories, 'groups', []),
      feed: feedData ? (feedData.items || []) : [],
      feedNextCursor: feedData && feedData.meta ? (feedData.meta.nextCursor || null) : null,
      reels: pick(reels, 'reels', []),
      featuredProducts: pick(featured, 'products', []),
      newProducts: pick(fresh, 'products', []),
      featuredBazars: pick(bazars, 'bazars', []),
      categories: pick(cats, 'categories', [])
    });
  } catch (err) {
    logger.error(`[Experience.home] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/explore ─────────────────────────────────────────────
const explore = async (req, res) => {
  try {
    const c = ctx(req);
    const [cats, trending, reels, ranking, bazars] = await Promise.allSettled([
      internalCall(productCtrl.categoriesOverview, c),
      internalCall(productCtrl.list, c, { query: { sort: 'sales', limit: 12 } }),
      internalCall(reelCtrl.listGlobal, c, { query: { limit: 10 } }),
      internalCall(bazarCtrl.ranking, c),
      internalCall(bazarCtrl.list, c, { query: { limit: 10 } })
    ]);
    return ok(res, {
      categories: pick(cats, 'categories', []),
      trendingProducts: pick(trending, 'products', []),
      trendingReels: pick(reels, 'reels', []),
      topBazars: pick(ranking, 'ranking', []),
      featuredBazars: pick(bazars, 'bazars', [])
    });
  } catch (err) {
    logger.error(`[Experience.explore] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/products/:id/view ───────────────────────────────────
const productView = async (req, res) => {
  try {
    const c = ctx(req);
    const main = await internalCall(productCtrl.getOne, c, { params: { id: req.params.id } });
    if (!main.ok) return main.status === 404 ? notFound(res, 'Produto não encontrado.') : serverError(res);

    const product = main.data.product;
    const { bazar, reviews, ...productOnly } = product;

    const [related, sellerProducts, productReels, comments] = await Promise.allSettled([
      internalCall(productCtrl.related, c, { params: { id: product.id } }),
      internalCall(productCtrl.list, c, { query: { bazarId: product.bazarId, sort: 'sales', limit: 9 } }),
      prisma.reel.findMany({
        where: { productId: product.id, bazar: { active: true } },
        take: 6, orderBy: { createdAt: 'desc' },
        include: { images: { orderBy: { order: 'asc' }, take: 1 }, bazar: { select: { id: true, name: true, slug: true, logoUrl: true } } }
      }),
      internalCall(require('./commentController').list, c, { params: { id: product.id }, query: { limit: 5 } })
    ]);

    return ok(res, {
      product: productOnly,
      bazar: bazar || null,
      reviews: reviews || [],
      relatedProducts: pick(related, 'products', []),
      sellerProducts: pick(sellerProducts, 'products', []).filter(p => p.id !== product.id).slice(0, 8),
      recommendedReels: productReels.status === 'fulfilled' ? productReels.value : [],
      comments: pick(comments, 'comments', []),
      viewer: { saved: !!product.isFavorite, authenticated: !!req.user }
    });
  } catch (err) {
    logger.error(`[Experience.productView] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/bazars/:idOrSlug/view ───────────────────────────────
const bazarView = async (req, res) => {
  try {
    const c = ctx(req);
    const params = { idOrSlug: req.params.idOrSlug };
    const main = await internalCall(bazarCtrl.getOne, c, { params });
    if (!main.ok) return main.status === 404 ? notFound(res, 'Bazar não encontrado.') : serverError(res);

    const { products, seller, isFollowing, isBlocked, ...bazar } = main.data.bazar;
    const [reels, posts] = await Promise.allSettled([
      internalCall(reelCtrl.list, c, { params, query: { limit: 10 } }),
      internalCall(announcementCtrl.list, c, { params, query: { limit: 10 } })
    ]);

    return ok(res, {
      bazar,
      owner: seller || null,
      products: products || [],
      posts: pick(posts, 'announcements', []),
      reels: pick(reels, 'reels', []),
      stats: { followers: bazar.followerCount || 0, products: (products || []).length },
      viewer: { following: !!isFollowing, blocked: !!isBlocked, authenticated: !!req.user }
    });
  } catch (err) {
    logger.error(`[Experience.bazarView] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { home, explore, productView, bazarView };
