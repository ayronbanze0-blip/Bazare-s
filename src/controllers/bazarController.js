'use strict';

const { validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, forbidden, notFound, conflict, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, sanitize, uniqueSlug } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── PUBLIC: List bazars ─────────────────────────────────────────
const list = async (req, res) => {
  try {
    const { q, category, page = 1, limit = 20 } = req.query;
    const { take, skip } = paginate(page, limit);

    const where = {
      active: true,
      ...(q && { name: { contains: q, mode: 'insensitive' } }),
      ...(category && { category })
    };

    const [bazars, total] = await Promise.all([
      prisma.bazar.findMany({
        where, take, skip, orderBy: { createdAt: 'desc' },
        include: {
          seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true } },
          _count: { select: { products: { where: { active: true } } } }
        }
      }),
      prisma.bazar.count({ where })
    ]);

    return ok(res, { bazars, meta: paginateMeta(total, page, limit) });
  } catch (err) {
    logger.error(`[Bazars.list] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Get bazar by id or slug ─────────────────────────────
const getOne = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const bazar = await prisma.bazar.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], active: true },
      include: {
        seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true, avatarUrl: true } },
        products: {
          where: { active: true },
          orderBy: { createdAt: 'desc' },
          include: { images: { orderBy: { order: 'asc' }, take: 1 } }
        }
      }
    });

    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    return ok(res, { bazar });
  } catch (err) {
    logger.error(`[Bazars.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Create my bazar ─────────────────────────────────────
const create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return validationError(res, errors.array());

  try {
    const existing = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (existing) return conflict(res, 'Já possui um Bazar criado.');

    const { name, description, category, phone, location } = req.body;
    const slug = await uniqueSlug(prisma, name, 'bazar');

    const bazar = await prisma.bazar.create({
      data: {
        sellerId: req.user.id,
        name: sanitize(name),
        slug,
        description: sanitize(description),
        category,
        phone: phone || null,
        location: location || null,
        feeRate: parseFloat(process.env.DEFAULT_FEE_RATE) || 2.0
      }
    });

    logger.info(`[Bazars] Created: ${bazar.name} by ${req.user.email}`);
    return created(res, { bazar }, 'Bazar criado com sucesso.');
  } catch (err) {
    logger.error(`[Bazars.create] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Update my bazar ──────────────────────────────────────
const update = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findUnique({ where: { sellerId: req.user.id } });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId !== req.user.id && req.user.role !== 'ADMIN') return forbidden(res);

    const { name, description, category, phone, location } = req.body;
    let slug = bazar.slug;
    if (name && name !== bazar.name) slug = await uniqueSlug(prisma, name, 'bazar', bazar.id);

    const updated = await prisma.bazar.update({
      where: { id: bazar.id },
      data: {
        ...(name && { name: sanitize(name), slug }),
        ...(description && { description: sanitize(description) }),
        ...(category && { category }),
        ...(phone !== undefined && { phone }),
        ...(location !== undefined && { location })
      }
    });

    // Handle banner upload
    if (req.file) {
      const result = await uploadSvc.uploadBazarBanner(req.file.path);
      if (result.ok) {
        await prisma.bazar.update({ where: { id: bazar.id }, data: { bannerUrl: result.url } });
        updated.bannerUrl = result.url;
      }
    }

    return ok(res, { bazar: updated }, 'Bazar actualizado.');
  } catch (err) {
    logger.error(`[Bazars.update] ${err.message}`);
    return serverError(res);
  }
};

// ─── SELLER: Get my bazar ─────────────────────────────────────────
const myBazar = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findUnique({
      where: { sellerId: req.user.id },
      include: {
        _count: { select: { products: true, orders: true } }
      }
    });
    if (!bazar) return notFound(res, 'Ainda não criou um Bazar.');
    return ok(res, { bazar });
  } catch (err) {
    logger.error(`[Bazars.myBazar] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, create, update, myBazar };
