'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/orderController');
const { authenticate, isBuyer } = require('../middleware/auth');

const orderValidation = [
  body('items').isArray({ min: 1 }).withMessage('Pelo menos um item é obrigatório.'),
  body('buyerPhone').notEmpty().withMessage('Telefone obrigatório.'),
  body('address').notEmpty().withMessage('Morada obrigatória.')
];

const reviewValidation = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Avaliação deve ser entre 1 e 5.')
];

router.post('/', authenticate, orderValidation, ctrl.placeOrder);
router.get('/mine', authenticate, ctrl.myOrders);
router.get('/received', authenticate, ctrl.sellerOrders);
router.get('/:id', authenticate, ctrl.getOne);
router.patch('/:id/status', authenticate, ctrl.updateStatus);
router.post('/:id/review', authenticate, reviewValidation, ctrl.submitReview);

module.exports = router;
