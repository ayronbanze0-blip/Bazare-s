'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.list);
router.patch('/:id/read', authenticate, ctrl.markRead);
router.patch('/read-all', authenticate, ctrl.markAllRead);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;
