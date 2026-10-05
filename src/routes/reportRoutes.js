'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');
const { socialWriteLimiter } = require('../middleware/rateLimiter');

router.post('/', authenticate, socialWriteLimiter, ctrl.submit);
router.get('/mine', authenticate, ctrl.myReports);

module.exports = router;
