'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.myChats);
router.get('/unread-count', authenticate, ctrl.unreadCount);
router.get('/with/:userId', authenticate, ctrl.getOrCreateChat);
router.get('/:chatId/messages', authenticate, ctrl.getMessages);
router.post('/:chatId/messages', authenticate, ctrl.sendMessage);

module.exports = router;
