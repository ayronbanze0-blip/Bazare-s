'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/userController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { upload } = require('../services/uploadService');
const { uploadLimiter } = require('../middleware/rateLimiter');

// ─── Authenticated ────────────────────────────────────────────────
router.get('/me/stats', authenticate, ctrl.myStats);
router.put('/me', authenticate, uploadLimiter, upload.single('avatar'), ctrl.updateProfile);
router.put('/me/cover', authenticate, uploadLimiter, upload.single('cover'), ctrl.updateCover);
router.put('/me/password', authenticate, ctrl.changePassword);
router.put('/me/onboarding', authenticate, ctrl.onboarding);
router.delete('/me', authenticate, ctrl.deleteAccount);
router.post('/:id/thumb', authenticate, ctrl.sendThumb);

// ─── Public ───────────────────────────────────────────────────────
// Deve ficar por último para não capturar /me como :id
router.get('/:id', optionalAuth, ctrl.publicProfile);

module.exports = router;
