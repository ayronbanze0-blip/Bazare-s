'use strict';

const { validationResult } = require('express-validator');

const { ok, created, badRequest, forbidden, notFound, conflict, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, sanitize, uniqueSlug, startOfWeek, startOfMonth, getBadgeTier } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const logger = require('../utils/logger');

const prisma = require('../config/database');

// ─── Vendas do mês corrente por vendedor (para medalhas) ──────────
// Agrupa encomendas ENTREGUE deste mês por sellerId. Usado para calcular
// a medalha (Bronze/Prata/Ouro) e para ordenar os bazares Ouro no topo.
const monthlySalesBySeller = async (sellerIds = []) => {
  if (!sellerIds.length) return {};
  const rows = await prisma.order.groupBy({
    by: ['sellerId'],
    where: { sellerId: { in: sellerIds }, status: 'ENTREGUE', createdAt: { gte: startOfMonth() } },
    _count: { _all: true }
  });
  const map = {};
  rows.forEach(r => { map[r.sellerId] = r._count._all; });
  return map;
};

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

    // Vem-se a lista completa (limitada) para poder ordenar por medalha —
    // os bazares Ouro ficam sempre no topo, depois Prata, depois Bronze,
    // mantendo a ordem por mais recente dentro de cada nível.
    const all = await prisma.bazar.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 500,
      include: {
        seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true, thumbsUp: true, thumbsDown: true } },
        _count: { select: { products: { where: { active: true } } } }
      }
    });

    const salesMap = await monthlySalesBySeller(all.map(b => b.sellerId));
    const withBadge = all.map(b => {
      const monthlySales = salesMap[b.sellerId] || 0;
      return { ...b, monthlySales, badge: getBadgeTier(monthlySales) };
    });
    withBadge.sort((a, b) => b.badge.rank - a.badge.rank || b.monthlySales - a.monthlySales);

    const total = withBadge.length;
    const bazars = withBadge.slice(skip, skip + take);

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

    // Regista a visita (não bloqueia a resposta) — usado para "quantos
    // visitaram o seu bazar esta semana" no painel do vendedor.
    prisma.bazarVisit.create({
      data: { bazarId: bazar.id, visitorId: req.user?.id || null }
    }).catch(err => logger.warn(`[Bazars.getOne] Falha ao registar visita: ${err.message}`));

    const [weeklyVisits, monthlySales] = await Promise.all([
      prisma.bazarVisit.count({ where: { bazarId: bazar.id, createdAt: { gte: startOfWeek() } } }),
      prisma.order.count({ where: { sellerId: bazar.sellerId, status: 'ENTREGUE', createdAt: { gte: startOfMonth() } } })
    ]);

    return ok(res, { bazar: { ...bazar, weeklyVisits, monthlySales, badge: getBadgeTier(monthlySales) } });
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

    let bazar;
    try {
      bazar = await prisma.bazar.create({
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
    } catch (createErr) {
      // P2002 em sellerId: um pedido concorrente (duplo clique em "Criar
      // Bazar") já criou o bazar entre a verificação acima e este create.
      if (createErr.code === 'P2002') return conflict(res, 'Já possui um Bazar criado.');
      throw createErr;
    }

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

    // Handle banner and/or logo upload — vêm em req.files (não req.file)
    // porque agora aceitamos dois campos de ficheiro em simultâneo.
    const bannerFile = req.files?.banner?.[0];
    const logoFile = req.files?.logo?.[0];

    if (bannerFile) {
      const result = await uploadSvc.uploadBazarBanner(bannerFile.path);
      if (result.ok) {
        await prisma.bazar.update({ where: { id: bazar.id }, data: { bannerUrl: result.url } });
        updated.bannerUrl = result.url;
      }
    }
    if (logoFile) {
      const result = await uploadSvc.uploadToCloud(logoFile.path, 'bazares/logos');
      if (result.ok) {
        await prisma.bazar.update({ where: { id: bazar.id }, data: { logoUrl: result.url } });
        updated.logoUrl = result.url;
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
        seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true, thumbsUp: true, thumbsDown: true } },
        _count: { select: { products: true, orders: true } }
      }
    });
    if (!bazar) return notFound(res, 'Ainda não criou um Bazar.');

    const [weeklyVisits, monthlySales] = await Promise.all([
      prisma.bazarVisit.count({ where: { bazarId: bazar.id, createdAt: { gte: startOfWeek() } } }),
      prisma.order.count({ where: { sellerId: req.user.id, status: 'ENTREGUE', createdAt: { gte: startOfMonth() } } })
    ]);
    const badge = getBadgeTier(monthlySales);
    // Próximo patamar, para mostrar progresso no painel ("faltam N vendas para Prata/Ouro").
    const nextTier = badge.tier === 'BRONZE' ? { label: 'Prata', needed: Math.max(0, 30 - monthlySales) }
      : badge.tier === 'PRATA' ? { label: 'Ouro', needed: Math.max(0, 51 - monthlySales) }
      : null;

    return ok(res, { bazar: { ...bazar, weeklyVisits, monthlySales, badge, nextTier } });
  } catch (err) {
    logger.error(`[Bazars.myBazar] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, create, update, myBazar };


