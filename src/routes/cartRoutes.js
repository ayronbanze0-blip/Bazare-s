'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/cartController');
const { authenticate, isBuyer } = require('../middleware/auth');

router.get('/', authenticate, isBuyer, ctrl.getCart);
router.post('/items', authenticate, isBuyer, ctrl.addItem);
router.patch('/items/:id', authenticate, isBuyer, ctrl.updateItem);
router.delete('/items/:id', authenticate, isBuyer, ctrl.removeItem);
router.delete('/', authenticate, isBuyer, ctrl.clearCart);

module.exports = router;
