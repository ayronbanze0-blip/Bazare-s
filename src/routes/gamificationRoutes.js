'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/gamificationController');
const { authenticate } = require('../middleware/auth');

router.get('/me', authenticate, ctrl.me);

module.exports = router;
