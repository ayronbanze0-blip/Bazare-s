'use strict';

const router = require('express').Router();
const { authenticate, isAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/featureFlagController');

// Tudo aqui é só-admin: ligar/desligar funcionalidades é uma ação
// sensível, equivalente a um mini-deploy.
router.get('/', authenticate, isAdmin, ctrl.index);
router.put('/:key', authenticate, isAdmin, ctrl.update);

module.exports = router;
