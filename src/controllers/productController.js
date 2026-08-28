'use strict';

const { validationResult } = require('express-validator');

const { ok, created, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, sanitize, parseLatLng, haversineKm } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const aiSvc = require('../services/aiService');
const { uniqueProductSlug } = require('../utils/slugify');
const premiumService = require('../services/premiumService');
const notificationSvc = require('../services/notificationService');
const { attachProductEngagement, attachFollowState } = require('../services/feedEngagementService');
const logger = require('../utils/logger');

const prisma = require('../config/database');

// ─── Marca isFavorite em cada produto de uma lista, numa única query ────
// Antes disto, listagens (list/featured/related) nunca calculavam
// isFavorite — o coração aparecia sempre vazio mesmo para produtos já
// favoritados, e tocar nele "removia" um favorito que o utilizador
// pensava estar a adicionar. Só a página de produto único (getOne)
// calculava isto correctamente.
async function attachFavorites(products, userId) {
  if (!userId || !products.length) {
    return products.map(p => ({ ...p, isFavorite: false }));
  }
  const favs = await prisma.favorite.findMany({
    where: { userId, productId: { in: products.map(p => p.id) } },
    select: { productId: true }
  });
  const favSet = new Set(favs.map(f => f.productId));
  return products.map(p => ({ ...p, isFavorite: favSet.has(p.id) }));
}

// ─── PUBLIC: List products ───────────────────────────────────────
const list = async (req, res) => {
  try {
    const { q, category, bazarId, sellerId, minPrice, maxPrice, sort = 'new', page = 1, limit = 20, lat, lng } = req.query;
    const { take, skip } = paginate(page, limit);
    const geo = sort === 'distance' ? parseLatLng(lat, lng) : null;

    // Limpa "destaques do dia" (Premium) expirados — barato (índice em
    // `featured`, normalmente 0 linhas afectadas) e garante que o selo
    // "Destaque" nunca fica pendurado depois das 24h combinadas.
    await prisma.product.updateMany({
      where: { featured: true, featuredUntil: { lt: new Date() } },
      data: { featured: false, featuredUntil: null }
    });

    const where = {
      active: true,
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } }
        ]
      }),
      ...(category && { category }),
      ...(bazarId && { bazarId }),
      ...(sellerId && { sellerId }),
      ...(minPrice && { price: { gte: parseFloat(minPrice) } }),
      ...(maxPrice && { price: { ...((minPrice && { gte: parseFloat(minPrice) }) || {}), lte: parseFloat(maxPrice) } })
    };

    // ─── "Perto de mim" ────────────────────────────────────────────
    // Só produtos cujo bazar tem localização exacta definida entram
    // nesta ordenação. Calculamos a distância (Haversine) em JS sobre
    // o conjunto já filtrado por texto/categoria/preço — não precisa
    // de PostGIS ao volume actual da loja. Se o pool ficar muito grande
    // no futuro, isto passa a valer a pena mover para SQL puro.
    if (geo) {
      const pool = await prisma.product.findMany({
        where: { ...where, bazar: { latitude: { not: null }, longitude: { not: null } } },
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          bazar: { select: { id: true, name: true, slug: true, latitude: true, longitude: true } },
          _count: { select: { reviews: true, favorites: true } }
        },
        take: 3000 // limite de segurança sobre o pool candidato à ordenação por distância
      });
      const withDistance = pool
        .map(p => ({ ...p, distanceKm: haversineKm(geo.latitude, geo.longitude, p.bazar.latitude, p.bazar.longitude) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      const total = withDistance.length;
      const products = withDistance.slice(skip, skip + take);
      const withFav = await attachFavorites(products, req.user?.id);
      return ok(res, { products: await attachProductEngagement(withFav, req.user?.id), meta: paginateMeta(total, page, limit) });
    }

    // No sort 'new' (o mais usado — é o default da listagem e da página
    // inicial), vendedores Premium aparecem primeiro. Nos outros sorts
    // explícitos (preço, avaliação, etc.) respeitamos a escolha do
    // utilizador sem reordenar por cima.
    // "Destaque do dia" (Premium): produto fixado pelo vendedor aparece
    // sempre primeiro, em qualquer critério de ordenação escolhido.
    const featuredFirst = { featured: 'desc' };
    const orderBy = {
      new: [featuredFirst, { seller: { isPremium: 'desc' } }, { createdAt: 'desc' }],
      old: [featuredFirst, { createdAt: 'asc' }],
      'price-asc': [featuredFirst, { price: 'asc' }],
      'price-desc': [featuredFirst, { price: 'desc' }],
      rating: [featuredFirst, { rating: 'desc' }],
      sales: [featuredFirst, { sales: 'desc' }],
      views: [featuredFirst, { views: 'desc' }]
    }[sort] || [featuredFirst, { seller: { isPremium: 'desc' } }, { createdAt: 'desc' }];

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where, orderBy, take, skip,
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          bazar: { select: { id: true, name: true, slug: true } },
          _count: { select: { reviews: true, favorites: true } }
        }
      }),
      prisma.product.count({ where })
    ]);

    const withEngagement = await attachProductEngagement(await attachFavorites(products, req.user?.id), req.user?.id);
    return ok(res, { products: await attachFollowState(withEngagement, req.user?.id), meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Products.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Category overview (counts of active products per category) ──
// Consumido por home.html na secção "Comunidades por categoria" — devolve
// só categorias com pelo menos 1 produto activo, ordenadas pela mais
// popular primeiro.
const categoriesOverview = async (req, res) => {
  try {
    const grouped = await prisma.product.groupBy({
      by: ['category'],
      where: { active: true },
      _count: { _all: true },
      orderBy: { _count: { category: 'desc' } },
      take: 12
    });
    const categories = grouped.map(g => ({ category: g.category, count: g._count._all }));
    return ok(res, { categories });
  } catch (err) {
    logger.error(`[Products.categoriesOverview] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Get single product ──────────────────────────────────
const getOne = async (req, res) => {
  try {
    // Aceita tanto o novo slug ("/produto/iphone-13-abc12") como o id
    // antigo (UUID), para não partir links já partilhados/indexados.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id);
    const product = await prisma.product.findFirst({
      where: { [isUuid ? 'id' : 'slug']: req.params.id, active: true },
      include: {
        images: { orderBy: { order: 'asc' } },
        bazar: {
          select: {
            id: true, name: true, slug: true, bannerUrl: true, phone: true, location: true,
            seller: { select: { verifiedSeller: true, isPremium: true } }
          }
        },
        reviews: {
          take: 10, orderBy: { createdAt: 'desc' },
          include: { buyer: { select: { id: true, name: true, avatarUrl: true } } }
        },
        _count: { select: { reviews: true, favorites: true } }
      }
    });

    if (!product) return notFound(res, 'Produto não encontrado.');

    // Increment views (non-blocking)
    prisma.product.update({ where: { id: product.id }, data: { views: { increment: 1 } } }).catch(() => {});

    // Check if in buyer's favorites
    let isFavorite = false;
    if (req.user) {
      const fav = await prisma.favorite.findUnique({
        where: { userId_productId: { userId: req.user.id, productId: product.id } }
      });
      isFavorite = !!fav;
    }

    return ok(res, { product: { ...product, isFavorite } });
  } catch (err) {
    logger.error(`[Products.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Create product ──────────────────────────────────────
const create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return badRequest(res, 'Crie o seu Bazar antes de adicionar produtos.');
    if (!bazar.active) return forbidden(res, 'O seu Bazar está inactivo.');

    const { name, description, price, category, stock, condition, size, color, location, deliveryMethod } = req.body;

    // ─── Moderação por IA ────────────────────────────────────────
    // Corre antes de gravar. Se a IA estiver indisponível, moderateProduct
    // devolve blocked=false (falha aberta) — não deixamos a plataforma
    // parada por causa de um problema no serviço externo de IA.
    const moderation = await aiSvc.moderateProduct({ name, description, category, price });
    if (moderation.blocked) {
      return badRequest(res, `Anúncio recusado pela moderação: ${moderation.reason}`);
    }

    // Verificação de duplicados: mesmo vendedor, nome muito parecido,
    // ainda activo. Isto é uma query directa, não depende da IA.
    const possibleDuplicate = await prisma.product.findFirst({
      where: { sellerId: req.user.id, active: true, name: { equals: sanitize(name), mode: 'insensitive' } }
    });
    if (possibleDuplicate) {
      return badRequest(res, 'Já tens um produto activo com este nome. Edita o existente ou usa um nome diferente.');
    }

    const slug = await uniqueProductSlug(
      { name: sanitize(name), location: location || req.user.location },
      async (candidate) => {
        const existing = await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } });
        return !!existing;
      }
    );

    const product = await prisma.product.create({
      data: {
        bazarId: bazar.id,
        sellerId: req.user.id,
        name: sanitize(name),
        slug,
        description: sanitize(description),
        price: parseFloat(price),
        category,
        stock: parseInt(stock) || 0,
        condition: condition || 'Novo',
        size: size || null,
        color: color || null,
        location: location || req.user.location || null,
        deliveryMethod: deliveryMethod || 'Combinado'
      }
    });

    // Handle uploaded images
    let imageUploadErrors = [];
    if (req.files && req.files.length > 0) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/products');
      const validImages = uploadResults.filter(r => r.ok);
      imageUploadErrors = uploadResults.filter(r => !r.ok).map(r => r.error);
      if (validImages.length > 0) {
        await prisma.productImage.createMany({
          data: validImages.map((r, i) => ({
            productId: product.id,
            url: r.url,
            publicId: r.publicId,
            order: i
          }))
        });
      }
    }

    // Handle URL-based images
    if (req.body.imageUrls) {
      const urls = Array.isArray(req.body.imageUrls) ? req.body.imageUrls : [req.body.imageUrls];
      const validUrls = urls.filter(u => u.startsWith('http')).slice(0, 20);
      if (validUrls.length > 0) {
        await prisma.productImage.createMany({
          data: validUrls.map((url, i) => ({ productId: product.id, url, order: i }))
        });
      }
    }

    const full = await prisma.product.findUnique({
      where: { id: product.id },
      include: { images: { orderBy: { order: 'asc' } } }
    });

    logger.info(`[Products] Created: ${product.name} by ${req.user.email}`);

    // Avisa quem segue este bazar — fire-and-forget: nunca deve
    // atrasar nem falhar a resposta de criação do produto.
    notificationSvc.newProductFromFollowed(bazar.id, req.user.name, product.name)
      .catch((e) => logger.error(`[Products.create] Notificação de seguidores falhou: ${e.message}`));

    const message = imageUploadErrors.length > 0
      ? `Produto criado, mas ${imageUploadErrors.length} imagem(ns) falharam ao enviar.`
      : 'Produto criado com sucesso.';
    return created(res, { product: full, imageUploadErrors }, message);
  } catch (err) {
    logger.error(`[Products.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Update product ──────────────────────────────────────
const update = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res, 'Produto não encontrado.');
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    const { name, description, price, category, stock, condition, size, color, location, deliveryMethod, active } = req.body;

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: {
        ...(name && { name: sanitize(name) }),
        ...(description && { description: sanitize(description) }),
        ...(price != null && { price: parseFloat(price) }),
        ...(category && { category }),
        ...(stock != null && { stock: Math.max(0, parseInt(stock)) }),
        ...(condition && { condition }),
        ...(size != null && { size: size || null }),
        ...(color != null && { color: color || null }),
        ...(location && { location }),
        ...(deliveryMethod && { deliveryMethod }),
        ...(active != null && { active: Boolean(active) })
      },
      include: { images: { orderBy: { order: 'asc' } } }
    });

    // Handle new uploaded images
    let imageUploadErrors = [];
    if (req.files && req.files.length > 0) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/products');
      const validImages = uploadResults.filter(r => r.ok);
      imageUploadErrors = uploadResults.filter(r => !r.ok).map(r => r.error);
      const currentCount = await prisma.productImage.count({ where: { productId: product.id } });
      if (validImages.length > 0 && currentCount < 20) {
        await prisma.productImage.createMany({
          data: validImages.slice(0, 20 - currentCount).map((r, i) => ({
            productId: product.id, url: r.url, publicId: r.publicId, order: currentCount + i
          }))
        });
      }
    }

    const message = imageUploadErrors.length > 0
      ? `Produto actualizado, mas ${imageUploadErrors.length} imagem(ns) falharam ao enviar.`
      : 'Produto actualizado.';
    return ok(res, { product: updated, imageUploadErrors }, message);
  } catch (err) {
    logger.error(`[Products.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Reorder product images ──────────────────────────────
// Body: { imageIds: ['id1','id2',...] } in the desired display order.
// The first id in the array becomes the product's main/cover image.
const reorderImages = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res, 'Produto não encontrado.');
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    const { imageIds } = req.body;
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return badRequest(res, 'Lista de imagens inválida.');
    }

    const existing = await prisma.productImage.findMany({ where: { productId: product.id } });
    const existingIds = new Set(existing.map(i => i.id));
    const allBelongToProduct = imageIds.every(id => existingIds.has(id));
    if (!allBelongToProduct || imageIds.length !== existing.length) {
      return badRequest(res, 'A lista de imagens não corresponde às imagens deste produto.');
    }

    await prisma.$transaction(
      imageIds.map((id, i) => prisma.productImage.update({ where: { id }, data: { order: i } }))
    );

    const images = await prisma.productImage.findMany({
      where: { productId: product.id },
      orderBy: { order: 'asc' }
    });
    return ok(res, { images }, 'Ordem das imagens actualizada.');
  } catch (err) {
    logger.error(`[Products.reorderImages] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Delete product image ────────────────────────────────
const deleteImage = async (req, res) => {
  try {
    const image = await prisma.productImage.findUnique({ where: { id: req.params.imageId } });
    if (!image) return notFound(res, 'Imagem não encontrada.');

    const product = await prisma.product.findUnique({ where: { id: image.productId } });
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    if (image.publicId) await uploadSvc.deleteFromCloud(image.publicId);
    await prisma.productImage.delete({ where: { id: image.id } });

    return ok(res, {}, 'Imagem eliminada.');
  } catch (err) {
    logger.error(`[Products.deleteImage] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Toggle product active ──────────────────────────────
const toggle = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res);
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { active: !product.active }
    });
    return ok(res, { active: updated.active }, `Produto ${updated.active ? 'activado' : 'desactivado'}.`);
  } catch (err) {
    logger.error(`[Products.toggle] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Mark product as out of stock / available again ─────
// Stays visible in the store either way; only the "esgotado" badge
// and purchasability change, controlled via `stock`.
const toggleStock = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res);
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    const isOutOfStock = product.stock <= 0;
    let updated;
    if (isOutOfStock) {
      // Coming back into stock — restore a sane quantity if one was provided,
      // otherwise default to 1 so the product becomes purchasable again.
      const restoreQty = Math.max(1, parseInt(req.body?.stock) || 1);
      updated = await prisma.product.update({ where: { id: product.id }, data: { stock: restoreQty } });
    } else {
      // Remember the previous quantity isn't needed — going to 0 is enough
      // to mark it "esgotado" while keeping the listing visible.
      updated = await prisma.product.update({ where: { id: product.id }, data: { stock: 0 } });
    }

    return ok(res, { stock: updated.stock, outOfStock: updated.stock <= 0 },
      updated.stock <= 0 ? 'Produto marcado como esgotado.' : 'Produto marcado como disponível.');
  } catch (err) {
    logger.error(`[Products.toggleStock] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: My products ─────────────────────────────────────────
const myProducts = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where: { sellerId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take, skip,
        include: { images: { orderBy: { order: 'asc' }, take: 1 }, _count: { select: { reviews: true } } }
      }),
      prisma.product.count({ where: { sellerId: req.user.id } })
    ]);
    return ok(res, { products, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Products.myProducts] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: Toggle favorite ───────────────────────────────────────
const toggleFavorite = async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.active) return notFound(res, 'Produto não encontrado.');

    const key = { userId_productId: { userId: req.user.id, productId } };
    const existing = await prisma.favorite.findUnique({ where: key });

    if (existing) {
      try {
        await prisma.favorite.delete({ where: key });
      } catch (delErr) {
        // P2025: já foi removido por um pedido concorrente (ex: duplo
        // toque no coração) — o resultado final pretendido já foi
        // alcançado, por isso tratamos como sucesso em vez de erro.
        if (delErr.code !== 'P2025') throw delErr;
      }
      return ok(res, { isFavorite: false }, 'Removido dos favoritos.');
    } else {
      try {
        await prisma.favorite.create({ data: { userId: req.user.id, productId } });
      } catch (createErr) {
        // P2002: um pedido concorrente já criou o mesmo favorito
        // (mesma corrida de duplo toque) — idempotente, sucesso na mesma.
        if (createErr.code !== 'P2002') throw createErr;
      }
      return ok(res, { isFavorite: true }, 'Adicionado aos favoritos.');
    }
  } catch (err) {
    logger.error(`[Products.toggleFavorite] ${err.message}`);
    return serverError(res);
  }
};

// ─── BUYER: My favorites ─────────────────────────────────────────
const myFavorites = async (req, res) => {
  try {
    const favs = await prisma.favorite.findMany({
      where: { userId: req.user.id },
      include: {
        product: {
          include: { images: { orderBy: { order: 'asc' }, take: 1 }, bazar: { select: { name: true, slug: true } } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    // NOTA: a chave tem de ser "products" — todas as outras listagens de
    // produtos (list/featured/related/myProducts) usam esse nome, e é o
    // que o favorites.html lê (`res?.data?.products`). Chamar-lhe
    // "favorites" aqui fazia a página aparecer sempre vazia, mesmo com
    // favoritos guardados (o contador do dashboard, que conta directamente
    // na tabela Favorite, continuava certo — só esta listagem estava presa).
    return ok(res, { products: await attachProductEngagement(favs.map(f => f.product), req.user.id) });
  } catch (err) {
    logger.error(`[Products.myFavorites] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Delete product ──────────────────────────────────────
const remove = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return notFound(res, 'Produto não encontrado.');
    if (product.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    const orderItemCount = await prisma.orderItem.count({ where: { productId: product.id } });
    if (orderItemCount > 0) {
      // Product has order history — keep the row for buyers' order records,
      // just hide it from listings instead of a hard delete.
      await prisma.product.update({ where: { id: product.id }, data: { active: false } });
      return ok(res, { hardDeleted: false }, 'Este produto já tem encomendas associadas, por isso foi apenas ocultado (não eliminado) para preservar o histórico de pedidos.');
    }

    // Clean up images (Cloudinary) before removing the row
    const images = await prisma.productImage.findMany({ where: { productId: product.id } });
    for (const img of images) {
      if (img.publicId) await uploadSvc.deleteFromCloud(img.publicId).catch(() => {});
    }

    await prisma.$transaction([
      prisma.favorite.deleteMany({ where: { productId: product.id } }),
      prisma.cartItem.deleteMany({ where: { productId: product.id } }),
      prisma.report.deleteMany({ where: { targetProductId: product.id } }),
      prisma.productImage.deleteMany({ where: { productId: product.id } }),
      prisma.product.delete({ where: { id: product.id } })
    ]);

    logger.info(`[Products] Deleted: ${product.name} by ${req.user.email}`);
    return ok(res, { hardDeleted: true }, 'Produto eliminado com sucesso.');
  } catch (err) {
    logger.error(`[Products.remove] ${err.message}`);
    return serverError(res);
  }
};


// ─── PUBLIC: Increment product views ────────────────────────────
// Chamado pelo frontend quando o utilizador abre a página do produto.
// Fire-and-forget: não bloqueia o carregamento da página.
const trackView = async (req, res) => {
  // Responde imediatamente — o update é async e não bloqueia
  res.status(204).end();
  try {
    await prisma.product.updateMany({
      where: { id: req.params.id, active: true },
      data: { views: { increment: 1 } }
    });
  } catch (err) {
    logger.error(`[Products.trackView] ${err.message}`);
  }
};

// ─── PUBLIC: Featured / highlighted products ─────────────────────
// Produtos marcados como destaque pelo admin — para o banner/carousel da homepage.
const featured = async (req, res) => {
  try {
    // Limpa "destaques do dia" (Premium) já expirados antes de listar,
    // para que nunca apareça um produto pinado há mais de 24h.
    await prisma.product.updateMany({
      where: { featured: true, featuredUntil: { lt: new Date() } },
      data: { featured: false, featuredUntil: null }
    });
    const products = await prisma.product.findMany({
      where: { featured: true, active: true },
      take: 12,
      orderBy: { sales: 'desc' },
      include: {
        images: { take: 1, orderBy: { order: 'asc' } },
        bazar: { select: { id: true, name: true, slug: true } }
      }
    });
    return ok(res, { products: await attachProductEngagement(await attachFavorites(products, req.user?.id), req.user?.id) });
  } catch (err) {
    logger.error(`[Products.featured] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Related products ─────────────────────────────────────
// Produtos da mesma categoria, excluindo o actual.
const related = async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { category: true, bazarId: true }
    });
    if (!product) return ok(res, { products: [] });

    const products = await prisma.product.findMany({
      where: {
        active: true,
        category: product.category,
        id: { not: req.params.id }
      },
      take: 8,
      orderBy: { sales: 'desc' },
      include: {
        images: { take: 1, orderBy: { order: 'asc' } },
        bazar: { select: { name: true, slug: true } }
      }
    });
    return ok(res, { products: await attachProductEngagement(await attachFavorites(products, req.user?.id), req.user?.id) });
  } catch (err) {
    logger.error(`[Products.related] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/products/generate-description ─────────────────────
// Usado pelo botão "Gerar com IA" no formulário de criação de produto.
// Não grava nada — só devolve sugestões que o vendedor pode editar
// antes de submeter o formulário normal.
const generateDescription = async (req, res) => {
  try {
    const { name, category, keywords, condition } = req.body;
    if (!name || !name.trim()) return badRequest(res, 'Indica pelo menos o nome do produto.');

    const result = await aiSvc.generateProductDescription({
      name: sanitize(name),
      category,
      keywords: keywords ? sanitize(keywords) : '',
      condition
    });

    if (!result.ok) return badRequest(res, result.error || 'Não foi possível gerar a descrição.');

    return ok(res, {
      description: result.description,
      suggestedCategory: result.suggestedCategory,
      suggestedTitle: result.suggestedTitle
    });
  } catch (err) {
    logger.error(`[Products.generateDescription] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/products/:id/pin ────────────────────────────────────
// "Destaque do dia" — exclusivo Conta Premium. Fixa 1 produto no topo
// do bazar e das pesquisas por 24h. Fixar um novo produto substitui
// automaticamente o destaque anterior do mesmo vendedor.
const pin = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!premiumService.isActive(user)) {
      return forbidden(res, 'O "Destaque do dia" é exclusivo da Conta Premium.');
    }

    const product = await prisma.product.findFirst({
      where: { id: req.params.id, sellerId: req.user.id }
    });
    if (!product) return notFound(res, 'Produto não encontrado.');

    const featuredUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      // Só pode haver 1 destaque activo por vendedor de cada vez.
      prisma.product.updateMany({
        where: { sellerId: req.user.id, featured: true, id: { not: product.id } },
        data: { featured: false, featuredUntil: null }
      }),
      prisma.product.update({
        where: { id: product.id },
        data: { featured: true, featuredUntil }
      })
    ]);

    return ok(res, { featured: true, featuredUntil });
  } catch (err) {
    logger.error(`[Products.pin] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/products/:id/pin ──────────────────────────────────
const unpin = async (req, res) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, sellerId: req.user.id }
    });
    if (!product) return notFound(res, 'Produto não encontrado.');

    await prisma.product.update({
      where: { id: product.id },
      data: { featured: false, featuredUntil: null }
    });
    return ok(res, { featured: false });
  } catch (err) {
    logger.error(`[Products.unpin] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, featured, related, trackView, create, update, deleteImage, reorderImages, toggle, toggleStock, remove, myProducts, toggleFavorite, myFavorites, attachFavorites, generateDescription, pin, unpin, categoriesOverview };



