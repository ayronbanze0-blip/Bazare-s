'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/orderController');
const { authenticate } = require('../middleware/auth');
const { orderLimiter, walletMoneyLimiter } = require('../middleware/rateLimiter');
const { resolveAddressId } = require('../controllers/commerceController');

const orderValidation = [
  body('items').isArray({ min: 1 }).withMessage('Pelo menos um item é obrigatório.'),
  body('buyerPhone').notEmpty().withMessage('Telefone obrigatório.'),
  body('address').notEmpty().withMessage('Morada obrigatória.')
];

const reviewValidation = [
  // isInt rejeita strings e floats — usar toInt() + custom para ser permissivo
  body('rating')
    .notEmpty().withMessage('Avaliação obrigatória.')
    .customSanitizer(v => parseInt(v))
    .isInt({ min: 1, max: 5 }).withMessage('Avaliação deve ser entre 1 e 5.')
];

// resolveAddressId: se vier `addressId`, preenche morada/telefone/nome a partir da morada guardada (antes da validação)
router.post('/', authenticate, orderLimiter, resolveAddressId, orderValidation, ctrl.placeOrder);
router.get('/mine', authenticate, ctrl.myOrders);
router.get('/received', authenticate, ctrl.sellerOrders);
router.get('/:id', authenticate, ctrl.getOne);
router.patch('/:id/status', authenticate, ctrl.updateStatus);

// Compra segura com código (dinheiro retido). A disputa é POST /orders/:orderId/dispute (fase5Routes, serve os dois lados).
router.post('/:id/accept', authenticate, orderLimiter, ctrl.accept);
router.post('/:id/reject', authenticate, orderLimiter, ctrl.reject);
router.post('/:id/pay', authenticate, walletMoneyLimiter, ctrl.pay);
router.get('/:id/delivery-code', authenticate, walletMoneyLimiter, ctrl.deliveryCode);
router.post('/:id/release', authenticate, walletMoneyLimiter, ctrl.release);
router.post('/:id/review', authenticate, reviewValidation, ctrl.submitReview);

module.exports = router;
