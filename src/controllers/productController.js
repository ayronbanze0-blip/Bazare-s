'use strict';

const { validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, forbidden, notFound, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, sanitize } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── PUBLIC: List products ───────────────────────────────────────
const list = async (req, res) => {
  try {
    const { q, category, bazarId, sellerId, minPrice, maxPrice, sort = 'new', page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

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

    const orderBy = {
      new: { createdAt: 'desc' },
      old: { createdAt: 'asc' },
      'price-asc': { price: 'asc' },
      'price-desc': { price: 'desc' },
      rating: { rating: 'desc' },
      sales: { sales: 'desc' },
      views: { views: 'desc' }
    }[sort] || { createdAt: 'desc' };

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

    return ok(res, { products, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Products.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Get single product ──────────────────────────────────
const getOne = async (req, res) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, active: true },
      include: {
        images: { orderBy: { order: 'asc' } },
        bazar: {
          select: { id: true, name: true, slug: true, bannerUrl: true, phone: true, location: true }
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

    const product = await prisma.product.create({
      data: {
        bazarId: bazar.id,
        sellerId: req.user.id,
        name: sanitize(name),
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
    if (req.files && req.files.length > 0) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/products');
      const validImages = uploadResults.filter(r => r.ok);
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
    return created(res, { product: full }, 'Produto criado com sucesso.');
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
    if (req.files && req.files.length > 0) {
      const uploadResults = await uploadSvc.uploadMany(req.files, 'bazares/products');
      const validImages = uploadResults.filter(r => r.ok);
      const currentCount = await prisma.productImage.count({ where: { productId: product.id } });
      if (validImages.length > 0 && currentCount < 20) {
        await prisma.productImage.createMany({
          data: validImages.slice(0, 20 - currentCount).map((r, i) => ({
            productId: product.id, url: r.url, publicId: r.publicId, order: currentCount + i
          }))
        });
      }
    }

    return ok(res, { product: updated }, 'Produto actualizado.');
  } catch (err) {
    logger.error(`[Products.update] ${err.message}`);
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
      await prisma.favorite.delete({ where: key });
      return ok(res, { isFavorite: false }, 'Removido dos favoritos.');
    } else {
      await prisma.favorite.create({ data: { userId: req.user.id, productId } });
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
    return ok(res, { favorites: favs.map(f => f.product) });
  } catch (err) {
    logger.error(`[Products.myFavorites] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, create, update, deleteImage, toggle, myProducts, toggleFavorite, myFavorites };
