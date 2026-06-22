'use strict';

const router = require('express').Router();

router.use('/auth', require('./authRoutes'));
router.use('/products', require('./productRoutes'));
router.use('/bazars', require('./bazarRoutes'));
router.use('/orders', require('./orderRoutes'));
router.use('/finance', require('./financeRoutes'));
router.use('/chat', require('./chatRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/revendedor', require('./revendedorRoutes'));
router.use('/admin', require('./adminRoutes'));
router.use('/reports', require('./reportRoutes'));
router.use('/cart', require('./cartRoutes'));
router.use('/users', require('./userRoutes'));

router.get('/health', (req, res) => res.json({ success: true, message: 'Bazares API está operacional.', timestamp: new Date().toISOString() }));

module.exports = router;
