'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/webhookSubscriptionController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.list);
router.post('/', authenticate, ctrl.create);
router.get('/:id/deliveries', authenticate, ctrl.deliveries);
router.post('/:id/test', authenticate, ctrl.test);
router.patch('/:id', authenticate, ctrl.update);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;
