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

// Seller (must come before the generic /:id route below, otherwise
// Express would match '/mine' as getOne with id='mine')
router.get('/mine', authenticate, isSeller, ctrl.myProducts);
router.post('/', authenticate, isSeller, uploadLimiter, upload.array('images', 20), productValidation, ctrl.create);
router.put('/:id', authenticate, isSeller, uploadLimiter, upload.array('images', 20), ctrl.update);
router.patch('/:id/toggle', authenticate, isSeller, ctrl.toggle);
router.patch('/:id/stock', authenticate, isSeller, ctrl.toggleStock);
router.delete('/:id', authenticate, isSeller, ctrl.remove);
router.delete('/images/:imageId', authenticate, isSeller, ctrl.deleteImage);

// Buyer (also before /:id for the same reason as /mine above)
router.get('/favorites', authenticate, ctrl.myFavorites);
router.post('/:productId/favorite', authenticate, ctrl.toggleFavorite);

// Public — generic single-product lookup, must be registered last so it
// doesn't shadow the more specific routes above ('/mine', '/favorites', etc.)
router.get('/:id', optionalAuth, ctrl.getOne);

module.exports = router;
