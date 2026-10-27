'use strict';

const { MAX_IMAGES_PER_POST } = require('../config/uploadLimits');

const router = require('express').Router();
const ctrl = require('../controllers/communityController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { upload } = require('../services/uploadService');

// Nota: montado em /groups (não /communities) — ver comentário no
// topo de communityController.js sobre o contrato do frontend já
// construído em paralelo (comunidade.html/comunidades.html/
// nova-comunidade.html).

// ─── Grupos ────────────────────────────────────────────────────────
router.get('/', optionalAuth, ctrl.list);
router.post('/', authenticate, upload.single('cover'), ctrl.create);
router.get('/:idOrSlug', optionalAuth, ctrl.getOne);
router.put('/:idOrSlug', authenticate, upload.single('cover'), ctrl.update);
router.delete('/:idOrSlug', authenticate, ctrl.remove);

// ─── Adesão ─────────────────────────────────────────────────────────
router.post('/:idOrSlug/join', authenticate, ctrl.join);
router.post('/:idOrSlug/leave', authenticate, ctrl.leave);
router.get('/:idOrSlug/members', optionalAuth, ctrl.listMembers);
router.delete('/:idOrSlug/members/:userId', authenticate, ctrl.removeMember);
router.put('/:idOrSlug/members/:userId/role', authenticate, ctrl.updateMemberRole);

// ─── Pedidos de entrada (comunidades com aprovação) ─────────────────
router.get('/:idOrSlug/requests', authenticate, ctrl.listRequests);
router.post('/:idOrSlug/requests/:userId/approve', authenticate, ctrl.approveRequest);
router.post('/:idOrSlug/requests/:userId/decline', authenticate, ctrl.declineRequest);

// ─── Posts do grupo ─────────────────────────────────────────────────
router.get('/:idOrSlug/posts', optionalAuth, ctrl.listPosts);
router.get('/:idOrSlug/posts/:postId', optionalAuth, ctrl.getPost);
router.post('/:idOrSlug/posts', authenticate, upload.array('images', MAX_IMAGES_PER_POST), ctrl.createPost);
router.put('/:idOrSlug/posts/:postId', authenticate, ctrl.updatePost);
router.delete('/:idOrSlug/posts/:postId', authenticate, ctrl.removePost);
router.post('/:idOrSlug/posts/:postId/pin', authenticate, ctrl.pinPost);

module.exports = router;
