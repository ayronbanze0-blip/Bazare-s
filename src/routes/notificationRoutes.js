'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.list);
router.patch('/read-all', authenticate, ctrl.markAllRead);
router.post('/device-token', authenticate, ctrl.registerDevice);
// '/device-token' tem de vir ANTES de '/:id' — como ambas são rotas de um
// único segmento no mesmo método (DELETE), o Express corria pela ordem de
// registo e '/:id' apanhava "device-token" como se fosse um id de
// notificação, nunca deixando chegar a ctrl.unregisterDevice. Na prática
// isto significava que desligar as notificações push (ou fazer logout)
// nunca removia mesmo o token do dispositivo no servidor.
router.delete('/device-token', authenticate, ctrl.unregisterDevice);
router.patch('/:id/read', authenticate, ctrl.markRead);
router.delete('/:id', authenticate, ctrl.remove);

module.exports = router;
