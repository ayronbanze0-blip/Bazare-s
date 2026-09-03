'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/mediaController');
const { authenticate } = require('../middleware/auth');
const { uploadVideoEdit, uploadAudioOnly } = require('../services/uploadService');
const { uploadLimiter } = require('../middleware/rateLimiter');

// Recebe o vídeo bruto e os parâmetros do editor (corte, capa,
// ajustes visuais, música da biblioteca pessoal via audioId); devolve
// um jobId de imediato e processa em segundo plano.
// uploadLimiter estava em falta aqui — é o endpoint mais pesado de todos
// (corte/mistura/compressão com FFmpeg em segundo plano), e era o único
// endpoint de upload sem limite de pedidos por hora.
router.post(
  '/video/process',
  authenticate,
  uploadLimiter,
  uploadVideoEdit.fields([{ name: 'video', maxCount: 1 }]),
  ctrl.processVideo
);

// Polling do progresso/resultado do processamento.
router.get('/video/process/:jobId', authenticate, ctrl.getJobStatus);

// ─── Biblioteca pessoal de áudio (Fase 3) ──────────────────────────
// Um áudio escolhido no editor de vídeo sobe uma única vez para aqui;
// publicações seguintes reutilizam-no só pelo id, sem novo upload.
router.get('/audio', authenticate, ctrl.listAudio);
router.post('/audio', authenticate, uploadLimiter, uploadAudioOnly.single('audio'), ctrl.uploadAudio);
router.delete('/audio/:id', authenticate, ctrl.deleteAudio);

module.exports = router;
