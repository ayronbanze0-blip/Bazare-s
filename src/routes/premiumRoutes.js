'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/premiumController');
const { authenticate, isAdmin } = require('../middleware/auth');

// ─── ME ──────────────────────────────────────────────────────────
router.get('/me', authenticate, ctrl.myStatus);
router.post('/subscribe', authenticate, ctrl.subscribe);
router.get('/subscriptions/:id', authenticate, ctrl.subscriptionStatus);
router.post('/subscriptions/:id/cancel', authenticate, ctrl.cancelSubscription);
router.get('/analytics', authenticate, ctrl.analytics);
router.post('/enhance-photo', authenticate, ctrl.enhancePhoto);
router.get('/price-suggestion', authenticate, ctrl.priceSuggestion);
router.get('/quick-replies', authenticate, ctrl.listQuickReplies);
router.post('/quick-replies', authenticate, ctrl.createQuickReply);
router.delete('/quick-replies/:id', authenticate, ctrl.deleteQuickReply);

// ─── ADMIN ──────────────────────────────────────────────────────────
router.get('/admin/subscriptions', authenticate, isAdmin, ctrl.adminList);
router.post('/admin/:userId/grant', authenticate, isAdmin, ctrl.adminGrant);
router.post('/admin/:userId/revoke', authenticate, isAdmin, ctrl.adminRevoke);

module.exports = router;
