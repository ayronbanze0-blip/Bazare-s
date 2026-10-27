'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/friendController');
const { authenticate } = require('../middleware/auth');
const { socialWriteLimiter, walletLookupLimiter } = require('../middleware/rateLimiter');

// Amizade mútua (pedir → aceitar). Todas as rotas exigem sessão.
router.get('/', authenticate, ctrl.list);                                   // os meus amigos
router.get('/summary', authenticate, ctrl.summary);                         // { friends, received, sent }
router.get('/requests', authenticate, ctrl.requests);                       // ?box=received (por defeito) | sent
router.get('/suggestions', authenticate, ctrl.suggestions);                 // amigos de amigos + contas com loja
router.get('/search', authenticate, walletLookupLimiter, ctrl.search);      // ?q= (nome ou @username)
router.get('/status/:userId', authenticate, ctrl.status);
router.get('/mutual/:userId', authenticate, ctrl.mutual);               // amigos em comum com outra pessoa
router.post('/request/:userId', authenticate, socialWriteLimiter, ctrl.request);
router.post('/:id/accept', authenticate, socialWriteLimiter, ctrl.accept);
router.post('/:id/decline', authenticate, socialWriteLimiter, ctrl.decline);
router.delete('/with/:userId', authenticate, socialWriteLimiter, ctrl.removeWith);
router.delete('/:id', authenticate, socialWriteLimiter, ctrl.remove);

module.exports = router;
