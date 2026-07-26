'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/seoController');

router.get('/sitemap.xml', ctrl.sitemap);
router.get('/robots.txt', ctrl.robots);

module.exports = router;
