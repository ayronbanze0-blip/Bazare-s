'use strict';

/**
 * Endpoints GET de "navegação" do documento de arquitectura — para que
 * cada entidade (utilizador, bazar, produto, post, reel) tenha as suas
 * listas e detalhes públicos e o app nunca fique com ecrãs vazios.
 * Só leitura. Reutiliza helpers existentes (engagement, bloqueios, paginação).
 *
 * Nota de modelo: hoje só existe Follow utilizador→BAZAR (não há
 * utilizador→utilizador). Por isso "seguidores de um utilizador" = seguidores
 * do bazar dele; "a seguir" = bazares que ele segue (só o próprio vê).
 */

const { ok, notFound, forbidden, serverError } = require('../utils/response');
const { paginate, paginateMeta, cursorArgs, cursorResult } = require('../utils/helpers');
const {
  attachDirectEngagement, attachProductEngagement, attachReelEngagement, attachFollowState
} = require('../services/feedEngagementService');
const blockSvc = require('../services/blockService');
const feedCtrl = require('./feedController');
const productCtrl = require('./productController');
const userCtrl = require('./userController');
const { internalCall, pick } = require('../services/internalCall');
const logger = require('../utils/logger');
const prisma = require('../config/database');

const bazarOk = { active: true, seller: { active: true } };
const postInclude = {
  images: { orderBy: { order: 'asc' } },
  product: { select: { id: true, name: true, slug: true, price: true } },
  bazar: { select: { id: true, name: true, slug: true, logoUrl: true } },
  poll: true
};
const reelInclude = {
  images: { orderBy: { order: 'asc' } },
  bazar: { select: { id: true, name: true, slug: true, logoUrl: true } },
  product: { select: { id: true, name: true, slug: true, price: true } }
};
const prodInclude = {
  images: { take: 1, orderBy: { order: 'asc' } },
  bazar: { select: { id: true, name: true, slug: true } }
};

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hiddenSellerFilter = async (req) => {
  const hidden = await blockSvc.getHiddenUserIds(req.user?.id);
  return hidden.size ? { sellerId: { notIn: [...hidden] } } : {};
};
const wrap = (name, fn) => async (req, res) => {
  try { return await fn(req, res); }
  catch (err) { logger.error(`[Browse.${name}] ${err.message}`); return serverError(res); }
};
// Corre um handler existente com params trocados, sem duplicar a lógica.
const withParams = (req, params) => { const r = Object.create(req); r.params = params; return r; };

const resolveBazar = (idOrSlug) =>
  prisma.bazar.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], ...bazarOk } });
const resolveProduct = (idOrSlug) =>
  prisma.product.findFirst({
    where: { [isUuid(idOrSlug) ? 'id' : 'slug']: idOrSlug, active: true, bazar: { active: true } },
    select: { id: true, bazarId: true, sellerId: true, category: true }
  });
// Utilizador público + o seu bazar (se tiver), respeitando bloqueios.
const resolveUser = async (req) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, active: true },
    select: { id: true, bazar: { select: { id: true, active: true } } }
  });
  if (!user) return null;
  if (req.user && req.user.id !== user.id && await blockSvc.isBlockedEither(req.user.id, user.id)) return null;
  return user;
};
const emptyList = (key, req) => ({ [key]: [], meta: paginateMeta(0, req.query.page, req.query.limit) });

// Corre `where`/`include` num findMany paginado por cursor OU por page/limit,
// consoante o pedido — mesma forma de resposta nos dois casos:
// { [key]: [...], meta }.
const runPaged = async (key, model, where, include, req, defaultLimit = 20) => {
  const { cursor, limit = defaultLimit, page = 1 } = req.query;
  if (cursor !== undefined) {
    const rows = await prisma[model].findMany({
      where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(cursor || undefined, limit)
    });
    const { items, hasNext, nextCursor } = cursorResult(rows, limit);
    return { [key]: items, meta: { limit: Number(limit) || defaultLimit, hasNext, nextCursor } };
  }
  const { take, skip } = paginate(page, limit);
  const [rows, total] = await Promise.all([
    prisma[model].findMany({ where, include, take, skip, orderBy: { createdAt: 'desc' } }),
    prisma[model].count({ where })
  ]);
  return { [key]: rows, meta: paginateMeta(total, page, limit) };
};

// ═══ POSTS (Announcement) ═══════════════════════════════════════
const postsList = wrap('postsList', async (req, res) => {
  const { bazarId, productId, q } = req.query;
  const where = {
    bazar: bazarOk,
    ...(await hiddenSellerFilter(req)),
    ...(bazarId && { bazarId }),
    ...(productId && { productId }),
    ...(q && { text: { contains: q, mode: 'insensitive' } })
  };
  const { posts, meta } = await runPaged('posts', 'announcement', where, postInclude, req);
  return ok(res, { posts: await attachDirectEngagement(posts, req.user?.id, 'ANNOUNCEMENT'), meta });
});

const postOne = wrap('postOne', async (req, res) => {
  const post = await prisma.announcement.findFirst({
    where: { id: req.params.id, bazar: bazarOk, ...(await hiddenSellerFilter(req)) },
    include: postInclude
  });
  if (!post) return notFound(res, 'Post não encontrado.');
  const [withEng] = await attachDirectEngagement([post], req.user?.id, 'ANNOUNCEMENT');
  return ok(res, { post: withEng });
});

const postComments = (req, res) =>
  feedCtrl.listComments(withParams(req, { targetType: 'ANNOUNCEMENT', targetId: req.params.id }), res);

// ═══ REELS ══════════════════════════════════════════════════════
const reelOne = wrap('reelOne', async (req, res) => {
  const reel = await prisma.reel.findFirst({
    where: { id: req.params.id, bazar: bazarOk, ...(await hiddenSellerFilter(req)) },
    include: reelInclude
  });
  if (!reel) return notFound(res, 'Reel não encontrado.');
  const [withEng] = await attachFollowState(await attachReelEngagement([reel], req.user?.id), req.user?.id);
  return ok(res, { reel: withEng });
});

const reelComments = (req, res) =>
  feedCtrl.listComments(withParams(req, { targetType: 'REEL', targetId: req.params.id }), res);

// ═══ PRODUTOS ═══════════════════════════════════════════════════
const productReviews = wrap('productReviews', async (req, res) => {
  const product = await resolveProduct(req.params.id);
  if (!product) return notFound(res, 'Produto não encontrado.');
  const { page = 1, limit = 10 } = req.query;
  const { take, skip } = paginate(page, limit);
  const where = { productId: product.id };
  const [reviews, total, agg] = await Promise.all([
    prisma.review.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { buyer: { select: { id: true, name: true, avatarUrl: true } } }
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({ where, _avg: { rating: true } })
  ]);
  return ok(res, { reviews, summary: { average: agg._avg.rating || 0, count: total }, meta: paginateMeta(total, page, limit) });
});

const sellerProducts = wrap('sellerProducts', async (req, res) => {
  const product = await resolveProduct(req.params.id);
  if (!product) return notFound(res, 'Produto não encontrado.');
  const { page = 1, limit = 12 } = req.query;
  const { take, skip } = paginate(page, limit);
  const where = { active: true, bazarId: product.bazarId, id: { not: product.id } };
  const [products, total] = await Promise.all([
    prisma.product.findMany({ where, take, skip, orderBy: { sales: 'desc' }, include: prodInclude }),
    prisma.product.count({ where })
  ]);
  return ok(res, {
    products: await attachProductEngagement(await productCtrl.attachFavorites(products, req.user?.id), req.user?.id),
    meta: paginateMeta(total, page, limit)
  });
});

// ═══ BAZARES ════════════════════════════════════════════════════
const bazarProducts = wrap('bazarProducts', async (req, res) => {
  const bazar = await resolveBazar(req.params.idOrSlug);
  if (!bazar) return notFound(res, 'Bazar não encontrado.');
  const where = { active: true, bazarId: bazar.id };

  // Cursor só faz sentido para o critério 'new' (o único que já bate com
  // orderBy createdAt+id do runPaged) — sort=sales/price/rating continua
  // por page/limit, como já estava.
  if (req.query.cursor !== undefined && (!req.query.sort || req.query.sort === 'new')) {
    const { products, meta } = await runPaged('products', 'product', where, prodInclude, req);
    return ok(res, {
      products: await attachProductEngagement(await productCtrl.attachFavorites(products, req.user?.id), req.user?.id),
      meta
    });
  }

  const { page = 1, limit = 20, sort = 'new' } = req.query;
  const { take, skip } = paginate(page, limit);
  const orderBy = { new: { createdAt: 'desc' }, sales: { sales: 'desc' }, views: { views: 'desc' },
    'price-asc': { price: 'asc' }, 'price-desc': { price: 'desc' }, rating: { rating: 'desc' } }[sort] || { createdAt: 'desc' };
  const [products, total] = await Promise.all([
    prisma.product.findMany({ where, take, skip, orderBy, include: prodInclude }),
    prisma.product.count({ where })
  ]);
  return ok(res, {
    products: await attachProductEngagement(await productCtrl.attachFavorites(products, req.user?.id), req.user?.id),
    meta: paginateMeta(total, page, limit)
  });
});

const bazarReviews = wrap('bazarReviews', async (req, res) => {
  const bazar = await resolveBazar(req.params.idOrSlug);
  if (!bazar) return notFound(res, 'Bazar não encontrado.');
  const { page = 1, limit = 10 } = req.query;
  const { take, skip } = paginate(page, limit);
  const where = { sellerId: bazar.sellerId };
  const [reviews, total, agg] = await Promise.all([
    prisma.review.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        product: { select: { id: true, name: true, slug: true } }
      }
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({ where, _avg: { rating: true } })
  ]);
  return ok(res, { reviews, summary: { average: agg._avg.rating || 0, count: total }, meta: paginateMeta(total, page, limit) });
});

const followersOfBazar = async (req, bazarId) => {
  const { page = 1, limit = 20 } = req.query;
  const { take, skip } = paginate(page, limit);
  const where = { bazarId, user: { active: true } };
  const [rows, total] = await Promise.all([
    prisma.follow.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } }
    }),
    prisma.follow.count({ where })
  ]);
  return { followers: rows.map((r) => ({ ...r.user, followedAt: r.createdAt })), meta: paginateMeta(total, page, limit) };
};

const bazarFollowers = wrap('bazarFollowers', async (req, res) => {
  const bazar = await resolveBazar(req.params.idOrSlug);
  if (!bazar) return notFound(res, 'Bazar não encontrado.');
  return ok(res, await followersOfBazar(req, bazar.id));
});

// ═══ UTILIZADORES ═══════════════════════════════════════════════
const userPosts = wrap('userPosts', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return notFound(res, 'Utilizador não encontrado.');
  if (!user.bazar?.active) return ok(res, emptyList('posts', req));
  const { posts, meta } = await runPaged('posts', 'announcement', { sellerId: user.id }, postInclude, req);
  return ok(res, { posts: await attachDirectEngagement(posts, req.user?.id, 'ANNOUNCEMENT'), meta });
});

const userReels = wrap('userReels', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return notFound(res, 'Utilizador não encontrado.');
  if (!user.bazar?.active) return ok(res, emptyList('reels', req));
  const { reels, meta } = await runPaged('reels', 'reel', { sellerId: user.id }, reelInclude, req, 12);
  return ok(res, { reels: await attachReelEngagement(reels, req.user?.id), meta });
});

const userProducts = wrap('userProducts', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return notFound(res, 'Utilizador não encontrado.');
  if (!user.bazar?.active) return ok(res, emptyList('products', req));
  const { products, meta } = await runPaged('products', 'product', { active: true, sellerId: user.id }, prodInclude, req);
  return ok(res, {
    products: await attachProductEngagement(await productCtrl.attachFavorites(products, req.user?.id), req.user?.id),
    meta
  });
});

const userFollowers = wrap('userFollowers', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return notFound(res, 'Utilizador não encontrado.');
  if (!user.bazar?.active) return ok(res, emptyList('followers', req));
  return ok(res, await followersOfBazar(req, user.bazar.id));
});

// Lista de quem alguém segue é privada: só o próprio (ou admin).
const userFollowing = wrap('userFollowing', async (req, res) => {
  if (req.user.id !== req.params.id && req.user.role !== 'ADMIN') return forbidden(res);
  const { page = 1, limit = 20 } = req.query;
  const { take, skip } = paginate(page, limit);
  const where = { userId: req.params.id, bazar: { active: true } };
  const [rows, total] = await Promise.all([
    prisma.follow.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { bazar: { select: { id: true, name: true, slug: true, logoUrl: true, category: true } } }
    }),
    prisma.follow.count({ where })
  ]);
  return ok(res, { following: rows.map((r) => ({ ...r.bazar, followedAt: r.createdAt })), meta: paginateMeta(total, page, limit) });
});

// GET /api/users/:id/view — perfil completo num só pedido.
const userView = wrap('userView', async (req, res) => {
  const c = { user: req.user, id: req.id, headers: req.headers };
  const profile = await internalCall(userCtrl.publicProfile, c, { params: { id: req.params.id } });
  if (!profile.ok) return notFound(res, 'Utilizador não encontrado.');
  const q = { page: 1, limit: 9 };
  const [products, reels, posts] = await Promise.allSettled([
    internalCall(userProducts, c, { params: { id: req.params.id }, query: q }),
    internalCall(userReels, c, { params: { id: req.params.id }, query: q }),
    internalCall(userPosts, c, { params: { id: req.params.id }, query: q })
  ]);
  const bazarId = profile.data.user.bazar?.id;
  const following = req.user && bazarId
    ? !!(await prisma.follow.findUnique({ where: { userId_bazarId: { userId: req.user.id, bazarId } } }))
    : false;
  return ok(res, {
    user: profile.data.user,
    products: pick(products, 'products', []),
    reels: pick(reels, 'reels', []),
    posts: pick(posts, 'posts', []),
    viewer: { myVote: profile.data.myVote, followingBazar: following, isSelf: req.user?.id === req.params.id, authenticated: !!req.user }
  });
});

module.exports = {
  postsList, postOne, postComments, reelOne, reelComments,
  productReviews, sellerProducts,
  bazarProducts, bazarReviews, bazarFollowers,
  userPosts, userReels, userProducts, userFollowers, userFollowing, userView
};
