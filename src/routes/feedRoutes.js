'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/feedController');
const { authenticate, optionalAuth } = require('../middleware/auth');

const commentValidation = [
  body('text').trim().isLength({ min: 1, max: 500 }).withMessage('Comentário deve ter entre 1 e 500 caracteres.')
];

router.get('/', optionalAuth, ctrl.list);
router.get('/:targetType/:targetId/engagement', optionalAuth, ctrl.engagement);
router.post('/:targetType/:targetId/react', authenticate, ctrl.react);
router.post('/:targetType/:targetId/share', authenticate, ctrl.share);
router.get('/:targetType/:targetId/comments', optionalAuth, ctrl.listComments);
router.post('/:targetType/:targetId/comments', authenticate, commentValidation, ctrl.createComment);
router.get('/comments/:commentId/replies', optionalAuth, ctrl.listReplies);
router.post('/comments/:commentId/like', authenticate, ctrl.likeComment);
router.delete('/comments/:commentId', authenticate, ctrl.removeComment);

module.exports = router;
