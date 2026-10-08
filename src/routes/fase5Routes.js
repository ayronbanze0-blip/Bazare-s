'use strict';

/**
 * Rotas da Fase 5 (app completo). Montado ANTES das rotas antigas para que caminhos como
 * /products/deals e /orders/buy-again não sejam capturados por `/:id`.
 * Cada rota declara explicitamente a sua autenticação/papel/limites (inline, para o auditor estático
 * scripts/route-audit.js os detectar) — nada depende da ordem de montagem.
 */
const router = require('express').Router();
const { authenticate, optionalAuth, isSeller, isAdmin } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { walletMoneyLimiter, publicTrackLimiter, socialWriteLimiter, accountSecurityLimiter, orderLimiter } = require('../middleware/rateLimiter');

const commerce = require('../controllers/commerceController');
const engage = require('../controllers/engagementController');
const support = require('../controllers/supportController');
const disputes = require('../controllers/disputeController');
const account = require('../controllers/accountController');

const payments = requireFeature('ENABLE_PAYMENTS');

// ─── Checkout ──────────────────────────────────────────────────────
router.post('/checkout/quote', authenticate, orderLimiter, commerce.quote);
router.post('/checkout/payment-options', authenticate, commerce.paymentOptions);

// ─── Cupões ────────────────────────────────────────────────────────
router.post('/coupons/validate', authenticate, orderLimiter, commerce.couponValidate);
router.get('/seller/coupons', authenticate, isSeller, commerce.couponList);
router.post('/seller/coupons', authenticate, isSeller, socialWriteLimiter, commerce.couponCreate);
router.patch('/seller/coupons/:id', authenticate, isSeller, socialWriteLimiter, commerce.couponUpdate);
router.delete('/seller/coupons/:id', authenticate, isSeller, commerce.couponDelete);
router.get('/seller/coupons/:id/redemptions', authenticate, isSeller, commerce.couponRedemptions);
router.get('/admin/coupons', authenticate, isAdmin, commerce.adminCouponList);
router.post('/admin/coupons/:id/disable', authenticate, isAdmin, commerce.adminCouponDisable);

// ─── Promoções / ofertas ───────────────────────────────────────────
router.get('/products/deals', optionalAuth, commerce.deals);
router.get('/seller/promotions', authenticate, isSeller, commerce.promoList);
router.put('/seller/promotions/:productId', authenticate, isSeller, socialWriteLimiter, commerce.promoUpsert);
router.delete('/seller/promotions/:productId', authenticate, isSeller, commerce.promoEnd);

// ─── Parcelas e pagamento com a carteira ───────────────────────────
router.get('/installments', authenticate, commerce.plansMine);
router.get('/installments/upcoming', authenticate, commerce.upcoming);
router.get('/installments/:id', authenticate, commerce.planOne);
router.post('/installments/:planId/pay', authenticate, payments, walletMoneyLimiter, commerce.pay);
router.put('/installments/:planId/autopay', authenticate, payments, commerce.autoPayToggle);
router.post('/installments/:planId/refund/retry', authenticate, payments, walletMoneyLimiter, commerce.retryRefund);
router.get('/seller/installments/settings', authenticate, isSeller, commerce.settingsGet);
router.put('/seller/installments/settings', authenticate, isSeller, socialWriteLimiter, commerce.settingsPut);
router.get('/seller/installments/plans', authenticate, isSeller, commerce.plansReceived);
router.get('/seller/installments/summary', authenticate, isSeller, commerce.sellerInstallmentSummary);
router.get('/admin/installments/overview', authenticate, isAdmin, commerce.adminInstallments);

// ─── Zonas de entrega e moradas ────────────────────────────────────
router.get('/delivery-zones/bazar/:bazarId', commerce.zonesOfBazar);
router.get('/seller/delivery-zones', authenticate, isSeller, commerce.zoneList);
router.post('/seller/delivery-zones', authenticate, isSeller, socialWriteLimiter, commerce.zoneCreate);
router.patch('/seller/delivery-zones/:id', authenticate, isSeller, socialWriteLimiter, commerce.zoneUpdate);
router.delete('/seller/delivery-zones/:id', authenticate, isSeller, commerce.zoneDelete);

router.get('/addresses', authenticate, commerce.addressList);
router.post('/addresses', authenticate, socialWriteLimiter, commerce.addressCreate);
router.patch('/addresses/:id', authenticate, socialWriteLimiter, commerce.addressUpdate);
router.post('/addresses/:id/default', authenticate, commerce.addressSetDefault);
router.delete('/addresses/:id', authenticate, commerce.addressDelete);

// ─── Extras de encomenda ───────────────────────────────────────────
router.get('/orders/buy-again', authenticate, commerce.buyAgain);
router.get('/orders/:id/timeline', authenticate, commerce.orderTimeline);
router.get('/orders/:id/receipt', authenticate, commerce.orderReceipt);

// ─── Disputas ──────────────────────────────────────────────────────
router.get('/disputes/reasons', disputes.reasons);
router.post('/orders/:orderId/dispute', authenticate, socialWriteLimiter, disputes.open);
router.get('/disputes/mine', authenticate, disputes.mine);
router.get('/disputes/received', authenticate, isSeller, disputes.received);
router.get('/disputes/:id', authenticate, disputes.getOne);
router.post('/disputes/:id/respond', authenticate, isSeller, socialWriteLimiter, disputes.respond);
router.post('/disputes/:id/cancel', authenticate, disputes.cancel);
router.get('/admin/disputes', authenticate, isAdmin, disputes.adminList);
router.post('/admin/disputes/:id/resolve', authenticate, isAdmin, disputes.resolve);

// ─── Visualizações ─────────────────────────────────────────────────
router.post('/views', optionalAuth, publicTrackLimiter, engage.trackView);
router.post('/views/batch', optionalAuth, publicTrackLimiter, engage.trackBatch);
router.get('/views/:type/:id/stats', authenticate, engage.viewStats);
router.get('/seller/views/summary', authenticate, isSeller, engage.sellerViewSummary);
router.get('/users/me/recently-viewed', authenticate, engage.recentlyViewed);
router.delete('/users/me/recently-viewed', authenticate, engage.clearRecentlyViewed);
router.delete('/users/me/recently-viewed/:productId', authenticate, engage.removeRecentlyViewed);

// ─── Banners ───────────────────────────────────────────────────────
router.get('/banners', optionalAuth, engage.bannerList);
router.post('/banners/:id/impression', optionalAuth, publicTrackLimiter, engage.bannerImpression);
router.post('/banners/:id/click', optionalAuth, publicTrackLimiter, engage.bannerClick);
router.get('/admin/banners', authenticate, isAdmin, engage.bannerAdminList);
router.post('/admin/banners', authenticate, isAdmin, engage.bannerCreate);
router.patch('/admin/banners/:id', authenticate, isAdmin, engage.bannerUpdate);
router.delete('/admin/banners/:id', authenticate, isAdmin, engage.bannerDelete);

// ─── Respostas a avaliações ────────────────────────────────────────
router.post('/reviews/:id/reply', authenticate, isSeller, socialWriteLimiter, engage.reviewReply);
router.delete('/reviews/:id/reply', authenticate, isSeller, engage.reviewReplyDelete);

// ─── Suporte ───────────────────────────────────────────────────────
router.post('/support/tickets', authenticate, socialWriteLimiter, support.create);
router.get('/support/tickets', authenticate, support.mine);
router.get('/support/tickets/:id', authenticate, support.getOne);
router.post('/support/tickets/:id/messages', authenticate, socialWriteLimiter, support.reply);
router.post('/support/tickets/:id/close', authenticate, support.close);
router.get('/admin/support/tickets', authenticate, isAdmin, support.adminList);
router.get('/admin/support/tickets/:id', authenticate, isAdmin, support.adminGet);
router.post('/admin/support/tickets/:id/reply', authenticate, isAdmin, support.adminReply);
router.patch('/admin/support/tickets/:id/status', authenticate, isAdmin, support.adminSetStatus);

// ─── Conta e app ───────────────────────────────────────────────────
router.get('/auth/sessions', authenticate, account.sessions);
router.delete('/auth/sessions/:id', authenticate, accountSecurityLimiter, account.revokeSession);
router.get('/users/me/export', authenticate, accountSecurityLimiter, account.exportData);
router.get('/app/version', account.version);

module.exports = router;
