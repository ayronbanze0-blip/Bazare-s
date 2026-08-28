'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/productController');
const commentCtrl = require('../controllers/commentController');
const { authenticate, isSeller, optionalAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { upload } = require('../services/uploadService');

const productValidation = [
  body('name').trim().isLength({ min: 3, max: 150 }).withMessage('Nome deve ter entre 3 e 150 caracteres.'),
  body('description').trim().isLength({ min: 10 }).withMessage('Descrição deve ter no mínimo 10 caracteres.'),
  body('price').isFloat({ gt: 0 }).withMessage('Preço deve ser maior que zero.'),
  body('category').notEmpty().withMessage('Categoria obrigatória.')
];

const commentValidation = [
  body('text').trim().isLength({ min: 1, max: 500 }).withMessage('Comentário deve ter entre 1 e 500 caracteres.')
];

// ─── Public ───────────────────────────────────────────────────────
router.get('/', optionalAuth, ctrl.list);
router.get('/featured', optionalAuth, ctrl.featured);
router.get('/categories-overview', optionalAuth, ctrl.categoriesOverview);

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
router.post('/:id/pin', authenticate, isSeller, ctrl.pin);       // Destaque do dia (Premium)
router.delete('/:id/pin', authenticate, isSeller, ctrl.unpin);

// ─── Buyer (antes de /:id pelo mesmo motivo) ─────────────────────
router.get('/favorites', authenticate, ctrl.myFavorites);
router.post('/:productId/favorite', authenticate, ctrl.toggleFavorite);

// ─── Comentários ──────────────────────────────────────────────────
router.get('/:id/comments', optionalAuth, commentCtrl.list);
router.post('/:id/comments', authenticate, commentValidation, commentCtrl.create);
router.get('/:id/comments/:commentId/replies', optionalAuth, commentCtrl.listReplies);
router.post('/:id/comments/:commentId/like', authenticate, commentCtrl.like);
router.delete('/:id/comments/:commentId', authenticate, commentCtrl.remove);

// ─── Public — lookup genérico (deve ser o último) ────────────────
router.get('/:id', optionalAuth, ctrl.getOne);
router.get('/:id/related', optionalAuth, ctrl.related);
router.post('/:id/viewed', ctrl.trackView);   // fire-and-forget, sem auth

module.exports = router;
