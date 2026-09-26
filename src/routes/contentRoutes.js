'use strict';

// Leitor unificado de conteúdo — GET /api/content/:targetType/:targetId
// Ver nota no topo de contentController.js.
const router = require('express').Router();
const ctrl = require('../controllers/contentController');
const { optionalAuth } = require('../middleware/auth');

router.get('/:targetType/:targetId', optionalAuth, ctrl.getOne);

module.exports = router;
