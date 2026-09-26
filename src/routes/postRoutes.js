'use strict';

// Posts públicos (Announcement) — leitura global, por id e comentários.
// Complementa GET /bazars/:idOrSlug/posts (posts de um único bazar).
const router = require('express').Router();
const browse = require('../controllers/browseController');
const { optionalAuth } = require('../middleware/auth');

router.get('/', optionalAuth, browse.postsList);
router.get('/:id', optionalAuth, browse.postOne);
router.get('/:id/comments', optionalAuth, browse.postComments);

module.exports = router;
