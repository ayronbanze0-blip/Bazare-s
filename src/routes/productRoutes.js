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

// ─── Public ───────────────────────────────────────────────────────
router.get('/', optionalAuth, ctrl.list);
router.get('/featured', optionalAuth, ctrl.featured);

// ─── Seller (antes de /:id para não ser capturado) ───────────────
router.get('/mine', authenticate, isSeller, ctrl.myProducts);
router.post('/generate-description', authenticate, isSeller, uploadLimiter, ctrl.generateDescription);
router.post('/', authenticate, isSeller, uploadLimiter, upload.array('images', 20), productValidation, ctrl.create);
router.put('/:id', authenticate, isSeller, uploadLimiter, upload.array('images', 20), ctrl.update);
router.patch('/:id/toggle', authenticate, isSeller, ctrl.toggle);
router.patch('/:id/stock', authenticate, isSeller, ctrl.toggleStock);
router.patch('/:id/images/reorder', authenticate, isSeller, ctrl.reorderImages);
router.delete('/:id', authenticate, isSeller, ctrl.remove);
router.delete('/images/:imageId', authenticate, isSeller, ctrl.deleteImage);

// ─── Buyer (antes de /:id pelo mesmo motivo) ─────────────────────
router.get('/favorites', authenticate, ctrl.myFavorites);
router.post('/:productId/favorite', authenticate, ctrl.toggleFavorite);

// ─── Public — lookup genérico (deve ser o último) ────────────────
router.get('/:id', optionalAuth, ctrl.getOne);
router.get('/:id/related', optionalAuth, ctrl.related);
router.post('/:id/viewed', ctrl.trackView);   // fire-and-forget, sem auth

module.exports = router;
