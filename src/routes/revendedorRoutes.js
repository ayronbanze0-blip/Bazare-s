'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/revendedorController');
const { authenticate, isAdmin, isRevendedor } = require('../middleware/auth');

// Admin manages invites
router.post('/invites', authenticate, isAdmin, ctrl.generateInvite);
router.get('/invites', authenticate, isAdmin, ctrl.listInvites);
router.delete('/invites/:id', authenticate, isAdmin, ctrl.revokeInvite);

// Public validation (used during registration)
router.get('/invites/:token/validate', ctrl.validateInvite);

// Revendedor panel
router.get('/me/sellers', authenticate, isRevendedor, ctrl.mySellers);
router.get('/me/finance', authenticate, isRevendedor, ctrl.myFinance);

// Available to any authenticated user (referral stats)
router.get('/me/referrals', authenticate, ctrl.myReferralStats);

module.exports = router;
