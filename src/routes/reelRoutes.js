'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/reelController');
const { optionalAuth } = require('../middleware/auth');

// Feed global de Reels (todos os bazares), mais recentes primeiro.
// Complementa GET /bazars/:idOrSlug/reels (reels de um único bazar).
router.get('/', optionalAuth, ctrl.listGlobal);

const browse = require('../controllers/browseController');
router.get('/:id', optionalAuth, browse.reelOne);
router.get('/:id/comments', optionalAuth, browse.reelComments);

module.exports = router;
