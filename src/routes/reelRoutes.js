'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/reelController');

// Feed global de Reels (todos os bazares), mais recentes primeiro.
// Complementa GET /bazars/:idOrSlug/reels (reels de um único bazar).
router.get('/', ctrl.listGlobal);

module.exports = router;
