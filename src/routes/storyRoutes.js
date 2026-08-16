'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/storyController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { uploadMedia } = require('../services/uploadService');

router.get('/', optionalAuth, ctrl.list);
router.post('/:id/view', authenticate, ctrl.markViewed);
router.post('/:storyId/reply', authenticate, ctrl.reply);
router.get('/:storyId/viewers', authenticate, ctrl.viewers);
router.get('/:storyId', authenticate, ctrl.getOne);
router.put('/:storyId', authenticate, uploadMedia.fields([{ name: 'image', maxCount: 1 }]), ctrl.updateText);
router.delete('/:storyId', authenticate, ctrl.remove);

module.exports = router;
