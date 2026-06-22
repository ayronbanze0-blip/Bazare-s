'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/bazarController');
const { authenticate, isSeller } = require('../middleware/auth');
const { upload } = require('../services/uploadService');

const bazarValidation = [
  body('name').trim().isLength({ min: 3, max: 100 }).withMessage('Nome deve ter entre 3 e 100 caracteres.'),
  body('description').trim().isLength({ min: 10 }).withMessage('Descrição deve ter no mínimo 10 caracteres.'),
  body('category').notEmpty().withMessage('Categoria obrigatória.')
];

router.get('/', ctrl.list);
router.get('/me', authenticate, isSeller, ctrl.myBazar);
router.get('/:idOrSlug', ctrl.getOne);
router.post('/', authenticate, isSeller, bazarValidation, ctrl.create);
router.put('/me', authenticate, isSeller, upload.single('banner'), ctrl.update);

module.exports = router;
