'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');
const { upload } = require('../services/uploadService');

router.get('/', authenticate, ctrl.myChats);
router.get('/unread-count', authenticate, ctrl.unreadCount);
router.get('/bazarbot', authenticate, ctrl.getBazarBotChat);
router.get('/with/:userId', authenticate, ctrl.getOrCreateChat);
router.get('/:chatId/messages', authenticate, ctrl.getMessages);
// upload.single('image') aceita multipart/form-data com campo "image"
// opcional — mensagens de texto puro continuam a funcionar sem ficheiro.
router.post('/:chatId/messages', authenticate, upload.single('image'), ctrl.sendMessage);
router.post('/:chatId/suggest-reply', authenticate, ctrl.suggestReply);

module.exports = router;
