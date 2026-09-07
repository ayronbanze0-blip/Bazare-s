'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/seoController');

router.get('/sitemap.xml', ctrl.sitemap);
router.get('/sitemap-main.xml', ctrl.sitemapMain);
router.get('/sitemap-products-:page.xml', ctrl.sitemapProducts);
router.get('/sitemap-bazars-:page.xml', ctrl.sitemapBazars);
router.get('/robots.txt', ctrl.robots);

module.exports = router;
