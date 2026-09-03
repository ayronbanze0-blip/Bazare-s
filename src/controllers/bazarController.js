'use strict';

const { validationResult } = require('express-validator');

const { ok, created, badRequest, forbidden, notFound, conflict, serverError, validationError } = require('../utils/response');
const { paginate, paginateMeta, sanitize, uniqueSlug, startOfMonth, getBadgeTier, parseLatLng } = require('../utils/helpers');
const uploadSvc = require('../services/uploadService');
const premiumService = require('../services/premiumService');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

const prisma = require('../config/database');
const { attachFavorites } = require('./productController');
const { attachProductEngagement } = require('../services/feedEngagementService');

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
        where, take, skip,
        orderBy: [{ seller: { isPremium: 'desc' } }, { createdAt: 'desc' }],
        include: {
          seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true, isPremium: true } },
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
        seller: { select: { id: true, name: true, rating: true, ratingCount: true, verifiedSeller: true, avatarUrl: true, isPremium: true } },
        products: {
          where: { active: true },
          orderBy: { createdAt: 'desc' },
          include: { images: { orderBy: { order: 'asc' }, take: 1 } }
        },
        _count: { select: { followers: true } }
      }
    });

    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    // Só esconde a loja quando foi o VENDEDOR que bloqueou o visitante —
    // se for o visitante quem bloqueou o vendedor, a página continua
    // acessível (com isBlocked:true) para ele poder desbloquear a
    // partir daqui; um 404 nos dois sentidos deixava isso impossível.
    if (req.user?.id) {
      const blockedByThem = await prisma.block.findUnique({
        where: { blockerId_blockedId: { blockerId: bazar.sellerId, blockedId: req.user.id } }
      });
      if (blockedByThem) return notFound(res, 'Bazar não encontrado.');
    }

    bazar.products = await attachProductEngagement(await attachFavorites(bazar.products, req.user?.id), req.user?.id);
    bazar.followerCount = bazar._count.followers;
    // isFollowing e isBlocked são independentes uma da outra — corriam em
    // sequência (2 idas à BD, uma a seguir à outra) sem motivo; em paralelo
    // ficam no tempo da mais lenta das duas, não da soma das duas.
    const [followRecord, blockRecord] = req.user
      ? await Promise.all([
          prisma.follow.findUnique({ where: { userId_bazarId: { userId: req.user.id, bazarId: bazar.id } } }),
          prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: req.user.id, blockedId: bazar.sellerId } } })
        ])
      : [null, null];
    bazar.isFollowing = !!followRecord;
    bazar.isBlocked = !!blockRecord;
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

    const { name, description, category, phone, location, latitude, longitude } = req.body;
    const slug = await uniqueSlug(prisma, name, 'bazar');
    const geo = parseLatLng(latitude, longitude);

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
          latitude: geo?.latitude ?? null,
          longitude: geo?.longitude ?? null,
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

    const { name, description, category, phone, location, latitude, longitude, promoTitle, promoSubtitle, promoColor } = req.body;
    let slug = bazar.slug;
    if (name && name !== bazar.name) slug = await uniqueSlug(prisma, name, 'bazar', bazar.id);

    // Coordenadas são opcionais e independentes uma da outra vindas do
    // corpo do pedido: só actualizamos quando o par é válido, para nunca
    // gravar uma latitude sem longitude (ou vice-versa) por engano.
    const geo = (latitude !== undefined || longitude !== undefined) ? parseLatLng(latitude, longitude) : undefined;

    // Banner promocional personalizado — exclusivo Premium. Se a conta
    // não está (ou já não está) activa, ignoramos silenciosamente estes
    // campos em vez de rejeitar o pedido inteiro — o resto da edição do
    // bazar deve continuar a funcionar normalmente.
    let promoData = {};
    if (promoTitle !== undefined || promoSubtitle !== undefined || promoColor !== undefined) {
      const me = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (premiumService.isActive(me)) {
        promoData = {
          ...(promoTitle !== undefined && { promoTitle: promoTitle ? sanitize(promoTitle).slice(0, 60) : null }),
          ...(promoSubtitle !== undefined && { promoSubtitle: promoSubtitle ? sanitize(promoSubtitle).slice(0, 100) : null }),
          ...(promoColor !== undefined && { promoColor: promoColor && /^#[0-9A-Fa-f]{6}$/.test(promoColor) ? promoColor : null })
        };
      }
    }

    const updated = await prisma.bazar.update({
      where: { id: bazar.id },
      data: {
        ...(name && { name: sanitize(name), slug }),
        ...(description && { description: sanitize(description) }),
        ...(category && { category }),
        ...(phone !== undefined && { phone }),
        ...(location !== undefined && { location }),
        ...(geo !== undefined && { latitude: geo?.latitude ?? null, longitude: geo?.longitude ?? null }),
        ...promoData
      }
    });

    // Handle banner and/or logo upload — vêm em req.files (não req.file)
    // porque agora aceitamos dois campos de ficheiro em simultâneo.
    const bannerFile = req.files?.banner?.[0];
    const logoFile = req.files?.logo?.[0];
    const imageUploadErrors = [];

    if (bannerFile) {
      const result = await uploadSvc.uploadBazarBanner(bannerFile.path);
      if (result.ok) {
        await prisma.bazar.update({ where: { id: bazar.id }, data: { bannerUrl: result.url } });
        updated.bannerUrl = result.url;
      } else {
        imageUploadErrors.push({ field: 'banner', error: result.error });
      }
    }
    if (logoFile) {
      const result = await uploadSvc.uploadToCloud(logoFile.path, 'bazares/logos');
      if (result.ok) {
        await prisma.bazar.update({ where: { id: bazar.id }, data: { logoUrl: result.url } });
        updated.logoUrl = result.url;
      } else {
        imageUploadErrors.push({ field: 'logo', error: result.error });
      }
    }

    const message = imageUploadErrors.length > 0
      ? `Bazar actualizado, mas ${imageUploadErrors.length} imagem(ns) falharam ao enviar.`
      : 'Bazar actualizado.';
    return ok(res, { bazar: updated, imageUploadErrors }, message);
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
        _count: { select: { products: true, orders: true } },
        // Faltava isto — sem o seller incluído, o frontend nunca recebia
        // rating/ratingCount/thumbs e mostrava sempre "Sem avaliações".
        seller: {
          select: { id: true, rating: true, ratingCount: true, thumbsUp: true, thumbsDown: true, verifiedSeller: true }
        }
      }
    });
    if (!bazar) return notFound(res, 'Ainda não criou um Bazar.');

    // Vendas entregues este mês — base do sistema de medalhas. Isto nunca
    // era calculado antes, por isso monthlySales chegava sempre a 0 ao
    // frontend e a medalha/barra/mensagem vinham todas erradas.
    const monthlySales = await prisma.order.count({
      where: { bazarId: bazar.id, status: 'ENTREGUE', deliveredAt: { gte: startOfMonth(new Date()) } }
    });

    const badge = getBadgeTier(monthlySales);
    const nextTier =
      badge.tier === 'BRONZE' ? { label: 'Prata', needed: Math.max(0, 30 - monthlySales) } :
      badge.tier === 'PRATA'  ? { label: 'Ouro',  needed: Math.max(0, 51 - monthlySales) } :
      null; // Ouro é o nível máximo — aqui sim faz sentido não haver próximo nível

    return ok(res, { bazar: { ...bazar, monthlySales, badge, nextTier } });
  } catch (err) {
    logger.error(`[Bazars.myBazar] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/bazars/:idOrSlug/whatsapp-click ─────────────────────
// Fire-and-forget, sem auth: conta cliques no botão "Contactar via
// WhatsApp" para alimentar a estatística de contactos (Conta Premium).
const trackWhatsappClick = async (req, res) => {
  try {
    await prisma.bazar.updateMany({
      where: { OR: [{ id: req.params.idOrSlug }, { slug: req.params.idOrSlug }] },
      data: { whatsappClicks: { increment: 1 } }
    });
  } catch (err) {
    logger.error(`[Bazar.trackWhatsappClick] ${err.message}`);
  }
  return ok(res, {});
};

// ─── POST /api/bazars/:idOrSlug/follow — alterna seguir/deixar de seguir ──
const toggleFollow = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findFirst({
      where: { OR: [{ id: req.params.idOrSlug }, { slug: req.params.idOrSlug }], active: true },
      select: { id: true, sellerId: true }
    });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');
    if (bazar.sellerId === req.user.id) return badRequest(res, 'Não pode seguir o seu próprio bazar.');

    const existing = await prisma.follow.findUnique({
      where: { userId_bazarId: { userId: req.user.id, bazarId: bazar.id } }
    });

    let following;
    if (existing) {
      await prisma.follow.delete({ where: { id: existing.id } });
      following = false;
    } else {
      await prisma.follow.create({ data: { userId: req.user.id, bazarId: bazar.id } });
      following = true;
      notifSvc.newFollower(bazar.sellerId, req.user.name, bazar.id).catch(() => {});
    }

    const followerCount = await prisma.follow.count({ where: { bazarId: bazar.id } });
    return ok(res, { following, followerCount });
  } catch (err) {
    logger.error(`[Bazar.toggleFollow] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/bazars/:idOrSlug/follow-status — só consulta, não altera ───
// Usado por my-bazar.html para mostrar o número de seguidores no dashboard
// sem correr o risco de acidentalmente alternar o estado (isso só o
// toggleFollow acima deve fazer).
const followStatus = async (req, res) => {
  try {
    const bazar = await prisma.bazar.findFirst({
      where: { OR: [{ id: req.params.idOrSlug }, { slug: req.params.idOrSlug }] },
      select: { id: true }
    });
    if (!bazar) return notFound(res, 'Bazar não encontrado.');

    const [followerCount, following] = await Promise.all([
      prisma.follow.count({ where: { bazarId: bazar.id } }),
      req.user
        ? prisma.follow.findUnique({ where: { userId_bazarId: { userId: req.user.id, bazarId: bazar.id } } }).then(f => !!f)
        : Promise.resolve(false)
    ]);

    return ok(res, { following, followerCount });
  } catch (err) {
    logger.error(`[Bazar.followStatus] ${err.message}`);
    return serverError(res);
  }
};

// ─── PUBLIC: Ranking de vendedores (vendas entregues este mês) ────
const MONTH_LABELS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const ranking = async (req, res) => {
  try {
    const monthStart = startOfMonth(new Date());

    const grouped = await prisma.order.groupBy({
      by: ['sellerId'],
      where: { status: 'ENTREGUE', deliveredAt: { gte: monthStart } },
      _count: { _all: true },
      orderBy: { _count: { sellerId: 'desc' } },
      take: 50
    });

    if (!grouped.length) {
      const now = new Date();
      return ok(res, { ranking: [], period: { label: `${MONTH_LABELS[now.getMonth()]} de ${now.getFullYear()}` } });
    }

    const sellerIds = grouped.map(g => g.sellerId);
    const sellers = await prisma.user.findMany({
      where: { id: { in: sellerIds } },
      select: {
        id: true, name: true, verifiedSeller: true,
        bazar: { select: { id: true, name: true, slug: true, logoUrl: true } }
      }
    });
    const sellerById = new Map(sellers.map(s => [s.id, s]));

    const list = grouped
      .map(g => sellerById.get(g.sellerId))
      .filter(s => s && s.bazar) // vendedor pode já não ter Bazar activo — não faz sentido no ranking
      .map((s, i) => {
        const totalEncomendas = grouped.find(g => g.sellerId === s.id)._count._all;
        return {
          rank: i + 1,
          name: s.name,
          verifiedSeller: s.verifiedSeller,
          bazar: s.bazar,
          badge: getBadgeTier(totalEncomendas),
          totalEncomendas
        };
      });

    const now = new Date();
    return ok(res, { ranking: list, period: { label: `${MONTH_LABELS[now.getMonth()]} de ${now.getFullYear()}` } });
  } catch (err) {
    logger.error(`[Bazars.ranking] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { list, getOne, create, update, myBazar, trackWhatsappClick, toggleFollow, followStatus, ranking };



