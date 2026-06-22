'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');

router.post('/', authenticate, ctrl.submit);
router.get('/mine', authenticate, ctrl.myReports);

module.exports = router;
