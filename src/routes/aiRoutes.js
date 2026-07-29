'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/aiController');
const { authenticate, isSeller } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');

router.post('/generate-caption', authenticate, isSeller, uploadLimiter, ctrl.generateCaption);

module.exports = router;
