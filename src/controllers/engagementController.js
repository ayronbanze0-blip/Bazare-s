'use strict';

/**
 * Engajamento: visualizações (contagem + estatísticas + "vistos recentemente"), banners da app e resposta a avaliações.
 */
const prisma = require('../config/database');
const { ok, created, noContent, accepted } = require('../utils/response');
const { handle, bad, notFoundErr, forbiddenErr } = require('../utils/appError');
const V = require('../utils/validate');
const viewSvc = require('../services/viewService');
const viewRules = require('../services/viewsRules');
const couponSvc = require('../services/couponService');
const notifSvc = require('../services/notificationService');
const { shouldCount } = require('../utils/dedupWindow');
const { isPublicHttpsUrl } = require('../utils/safeUrl');

const clientIp = (req) => (req.ip || (req.socket && req.socket.remoteAddress) || '');

// ═════════════════════════════════════════════════════════════════
// Visualizações
// ═════════════════════════════════════════════════════════════════
/** POST /views  { type, id }  → 204. Público (com ou sem sessão); nunca falha por causa de contagem. */
const trackView = handle('Views.track', async (req, res) => {
  V.bodyObject(req.body);
  const type = viewRules.parseTargetType(req.body.type);
  const id = V.id(req.body.id, 'id');
  await viewSvc.track({ type, id, userId: req.user ? req.user.id : null, ip: clientIp(req), userAgent: req.get('user-agent') || '' });
  return noContent(res);
});

/** POST /views/batch  { events:[{type,id}] }  — a app envia em lote o que acumulou offline. Máx. 25. */
const trackBatch = handle('Views.batch', async (req, res) => {
  V.bodyObject(req.body);
  const events = Array.isArray(req.body.events) ? req.body.events : null;
  if (!events) throw bad('"events" tem de ser uma lista.', 'VALIDATION_ERROR');
  if (events.length > 25) throw bad('No máximo 25 eventos por pedido.', 'VALIDATION_ERROR');
  const seen = new Set();
  let accepted_ = 0;
  for (const ev of events) {
    let type; let id;
    try { type = viewRules.parseTargetType(ev && ev.type); id = V.id(ev && ev.id, 'id'); } catch { continue; } // evento malformado é ignorado
    const key = `${type}:${id}`;
    if (seen.has(key)) continue; // repetidos no mesmo lote contam uma vez
    seen.add(key);
    const r = await viewSvc.track({ type, id, userId: req.user ? req.user.id : null, ip: clientIp(req), userAgent: req.get('user-agent') || '' });
    if (r.counted) accepted_++;
  }
  return accepted(res, { received: events.length, counted: accepted_ });
});

const viewStats = handle('Views.stats', async (req, res) => {
  const type = viewRules.parseTargetType(req.params.type);
  const id = V.id(req.params.id, 'id');
  const days = viewRules.parseDays(req.query.days);
  return ok(res, await viewSvc.targetStats(req.user, type, id, days));
});

const sellerViewSummary = handle('Views.sellerSummary', async (req, res) => ok(res, await viewSvc.sellerSummary(req.user.id, viewRules.parseDays(req.query.days))));

const recentlyViewed = handle('Views.recent', async (req, res) => {
  const items = await viewSvc.recentlyViewed(req.user.id, { limit: req.query.limit });
  const withPromos = await couponSvc.attachPromotions(items.map((i) => i.product), { viewerId: req.user.id });
  return ok(res, { items: items.map((i, idx) => ({ lastViewedAt: i.lastViewedAt, viewCount: i.viewCount, product: withPromos[idx] })) });
});
const clearRecentlyViewed = handle('Views.clear', async (req, res) => ok(res, { removed: await viewSvc.clearHistory(req.user.id) }, 'Histórico limpo.'));
const removeRecentlyViewed = handle('Views.removeOne', async (req, res) => ok(res, { removed: await viewSvc.removeFromHistory(req.user.id, V.id(req.params.productId, 'productId')) }));

// ═════════════════════════════════════════════════════════════════
// Banners
// ═════════════════════════════════════════════════════════════════
const PLACEMENTS = ['HOME_TOP', 'HOME_MID', 'EXPLORE', 'CHECKOUT'];
const AUDIENCES = ['ALL', 'BUYER', 'SELLER'];
const LINK_TYPES = ['NONE', 'PRODUCT', 'BAZAR', 'CATEGORY', 'URL'];

function parseBanner(body, { partial = false } = {}) {
  V.bodyObject(body);
  const has = (k) => body[k] !== undefined;
  const out = {};
  if (!partial || has('title')) out.title = V.text(body.title, 'title', { max: 80 });
  if (has('subtitle')) out.subtitle = V.text(body.subtitle, 'subtitle', { max: 140, required: false });
  if (!partial || has('imageUrl')) {
    if (!isPublicHttpsUrl(body.imageUrl)) throw bad('"imageUrl" tem de ser um https:// público.', 'VALIDATION_ERROR');
    out.imageUrl = body.imageUrl;
  }
  if (has('placement')) out.placement = V.oneOf(body.placement, 'placement', PLACEMENTS);
  if (has('audience')) out.audience = V.oneOf(body.audience, 'audience', AUDIENCES);
  if (has('position')) out.position = V.int(body.position, 'position', { min: 0, max: 999 });
  if (has('startsAt')) out.startsAt = body.startsAt === null ? null : V.date(body.startsAt, 'startsAt', { required: false });
  if (has('endsAt')) out.endsAt = body.endsAt === null ? null : V.date(body.endsAt, 'endsAt', { required: false });
  if (has('active')) out.active = V.bool(body.active, 'active', { def: true });
  if (has('linkType') || has('linkValue')) {
    const linkType = V.oneOf(body.linkType, 'linkType', LINK_TYPES, { def: 'NONE' });
    out.linkType = linkType;
    if (linkType === 'NONE') out.linkValue = null;
    else if (linkType === 'URL') {
      if (!isPublicHttpsUrl(body.linkValue)) throw bad('"linkValue" tem de ser um https:// público.', 'VALIDATION_ERROR');
      out.linkValue = body.linkValue;
    } else out.linkValue = V.text(body.linkValue, 'linkValue', { max: 120 });
  }
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) throw bad('O fim tem de ser depois do início.', 'VALIDATION_ERROR');
  return out;
}

/** GET /banners?placement=HOME_TOP — público; filtra por janela de datas e público-alvo. */
const bannerList = handle('Banners.list', async (req, res) => {
  const now = new Date();
  const placement = req.query.placement ? V.oneOf(req.query.placement, 'placement', PLACEMENTS) : undefined;
  const role = req.user ? req.user.role : null;
  const audiences = ['ALL', ...(role === 'SELLER' ? ['SELLER'] : []), ...(role && role !== 'SELLER' ? ['BUYER'] : []), ...(!role ? ['BUYER'] : [])];
  const banners = await prisma.banner.findMany({
    where: {
      active: true, ...(placement && { placement }), audience: { in: audiences },
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }]
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }], take: 20,
    select: { id: true, title: true, subtitle: true, imageUrl: true, linkType: true, linkValue: true, placement: true }
  });
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, { banners });
});

const bannerMetric = (field) => handle(`Banners.${field}`, async (req, res) => {
  const id = V.id(req.params.id);
  // 1 por pessoa/banner/hora — impede inflacionar métricas com repetições
  const who = req.user ? `u:${req.user.id}` : `ip:${clientIp(req)}`;
  if (shouldCount(`banner-${field}`, who, id, 60 * 60 * 1000)) {
    await prisma.banner.updateMany({ where: { id, active: true }, data: { [field]: { increment: 1 } } });
  }
  return noContent(res);
});

const bannerAdminList = handle('Banners.adminList', async (req, res) => ok(res, { banners: await prisma.banner.findMany({ orderBy: [{ placement: 'asc' }, { position: 'asc' }], take: 200 }) }));
const bannerCreate = handle('Banners.create', async (req, res) => created(res, { banner: await prisma.banner.create({ data: parseBanner(req.body) }) }, 'Banner criado.'));
const bannerUpdate = handle('Banners.update', async (req, res) => {
  const data = parseBanner(req.body, { partial: true });
  const r = await prisma.banner.updateMany({ where: { id: V.id(req.params.id) }, data });
  if (!r.count) throw notFoundErr('Banner não encontrado.');
  return ok(res, { banner: await prisma.banner.findUnique({ where: { id: req.params.id } }) }, 'Banner actualizado.');
});
const bannerDelete = handle('Banners.delete', async (req, res) => {
  const r = await prisma.banner.deleteMany({ where: { id: V.id(req.params.id) } });
  if (!r.count) throw notFoundErr('Banner não encontrado.');
  return ok(res, { deleted: true }, 'Banner removido.');
});

// ═════════════════════════════════════════════════════════════════
// Resposta do vendedor a uma avaliação
// ═════════════════════════════════════════════════════════════════
const reviewReply = handle('Reviews.reply', async (req, res) => {
  V.bodyObject(req.body);
  const reply = V.text(req.body.reply, 'reply', { min: 2, max: 600, multiline: true });
  const review = await prisma.review.findUnique({ where: { id: V.id(req.params.id) } });
  if (!review) throw notFoundErr('Avaliação não encontrada.');
  if (review.sellerId !== req.user.id) throw forbiddenErr('Só podes responder a avaliações dos teus produtos.');
  const updated = await prisma.review.update({ where: { id: review.id }, data: { sellerReply: reply, sellerRepliedAt: new Date() } });
  if (!review.sellerReply) {
    notifSvc.push(review.buyerId, { type: 'INFO', category: 'social', title: 'O vendedor respondeu à tua avaliação', message: reply.slice(0, 120), link: `product.html?id=${review.productId}` });
  }
  return ok(res, { review: updated }, 'Resposta publicada.');
});
const reviewReplyDelete = handle('Reviews.replyDelete', async (req, res) => {
  const r = await prisma.review.updateMany({ where: { id: V.id(req.params.id), sellerId: req.user.id }, data: { sellerReply: null, sellerRepliedAt: null } });
  if (!r.count) throw notFoundErr('Avaliação não encontrada.');
  return ok(res, { removed: true }, 'Resposta removida.');
});

module.exports = {
  trackView, trackBatch, viewStats, sellerViewSummary, recentlyViewed, clearRecentlyViewed, removeRecentlyViewed,
  bannerList, bannerImpression: bannerMetric('impressions'), bannerClick: bannerMetric('clicks'), bannerAdminList, bannerCreate, bannerUpdate, bannerDelete,
  reviewReply, reviewReplyDelete, parseBanner
};
