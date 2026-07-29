'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/bazarController');
const announcementCtrl = require('../controllers/announcementController');
const storyCtrl = require('../controllers/storyController');
const reelCtrl = require('../controllers/reelController');
const { authenticate, isSeller, optionalAuth } = require('../middleware/auth');
const { upload, uploadMedia, uploadVideo } = require('../services/uploadService');

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
// Até 6 fotos por anúncio (campo multipart "images"), como pedido em anuncio.html.
router.post('/:idOrSlug/announcements', authenticate, isSeller, upload.array('images', 6), announcementCtrl.create);
router.delete('/:idOrSlug/announcements/:announcementId', authenticate, isSeller, announcementCtrl.remove);

// Histórias: imagem OU vídeo no mesmo endpoint (campos "image" / "video").
router.post(
  '/:idOrSlug/stories',
  authenticate, isSeller,
  uploadMedia.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  storyCtrl.create
);

// Reels: vídeo (campo "video"), legenda opcional e produto associado opcional.
router.get('/:idOrSlug/reels', optionalAuth, reelCtrl.list);
router.post('/:idOrSlug/reels', authenticate, isSeller, uploadVideo.single('video'), reelCtrl.create);
router.delete('/:idOrSlug/reels/:reelId', authenticate, isSeller, reelCtrl.remove);

router.post('/', authenticate, isSeller, bazarValidation, ctrl.create);
router.put('/me', authenticate, isSeller, upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'logo', maxCount: 1 }]), ctrl.update);

module.exports = router;
