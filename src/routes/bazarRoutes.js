'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/bazarController');
const announcementCtrl = require('../controllers/announcementController');
const { authenticate, isSeller, optionalAuth } = require('../middleware/auth');
const { upload } = require('../services/uploadService');

const bazarValidation = [
  body('name').trim().isLength({ min: 3, max: 100 }).withMessage('Nome deve ter entre 3 e 100 caracteres.'),
  body('description').trim().isLength({ min: 10 }).withMessage('Descrição deve ter no mínimo 10 caracteres.'),
  body('category').notEmpty().withMessage('Categoria obrigatória.')
];

router.get('/', ctrl.list);
router.get('/me', authenticate, isSeller, ctrl.myBazar);
router.get('/:idOrSlug', optionalAuth, ctrl.getOne);
router.post('/:idOrSlug/whatsapp-click', ctrl.trackWhatsappClick);
router.post('/:idOrSlug/follow', authenticate, ctrl.toggleFollow);
router.get('/:idOrSlug/announcements', announcementCtrl.list);
router.post('/:idOrSlug/announcements', authenticate, isSeller, upload.single('image'), announcementCtrl.create);
router.delete('/:idOrSlug/announcements/:announcementId', authenticate, isSeller, announcementCtrl.remove);
router.post('/', authenticate, isSeller, bazarValidation, ctrl.create);
router.put('/me', authenticate, isSeller, upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'logo', maxCount: 1 }]), ctrl.update);

module.exports = router;
