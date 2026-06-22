'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/productController');
const { authenticate, isSeller, optionalAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { upload } = require('../services/uploadService');

const productValidation = [
  body('name').trim().isLength({ min: 3, max: 150 }).withMessage('Nome deve ter entre 3 e 150 caracteres.'),
  body('description').trim().isLength({ min: 10 }).withMessage('Descrição deve ter no mínimo 10 caracteres.'),
  body('price').isFloat({ gt: 0 }).withMessage('Preço deve ser maior que zero.'),
  body('category').notEmpty().withMessage('Categoria obrigatória.')
];

// Public
router.get('/', optionalAuth, ctrl.list);
router.get('/:id', optionalAuth, ctrl.getOne);

// Seller
router.get('/me/list', authenticate, isSeller, ctrl.myProducts);
router.post('/', authenticate, isSeller, uploadLimiter, upload.array('images', 20), productValidation, ctrl.create);
router.put('/:id', authenticate, isSeller, uploadLimiter, upload.array('images', 20), ctrl.update);
router.patch('/:id/toggle', authenticate, isSeller, ctrl.toggle);
router.delete('/images/:imageId', authenticate, isSeller, ctrl.deleteImage);

// Buyer
router.post('/:productId/favorite', authenticate, ctrl.toggleFavorite);
router.get('/me/favorites', authenticate, ctrl.myFavorites);

module.exports = router;
