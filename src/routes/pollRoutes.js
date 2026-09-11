'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/pollController');
const { authenticate, optionalAuth } = require('../middleware/auth');

router.post('/:pollId/vote', authenticate, ctrl.vote);
router.get('/:pollId', optionalAuth, ctrl.getOne);

module.exports = router;
