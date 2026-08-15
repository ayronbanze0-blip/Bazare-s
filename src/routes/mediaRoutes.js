'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/mediaController');
const { authenticate } = require('../middleware/auth');
const { uploadVideoEdit } = require('../services/uploadService');
const { uploadLimiter } = require('../middleware/rateLimiter');

// Recebe o vídeo bruto (+ áudio opcional) e os parâmetros do editor;
// devolve um jobId de imediato e processa em segundo plano.
// uploadLimiter estava em falta aqui — é o endpoint mais pesado de todos
// (corte/mistura/compressão com FFmpeg em segundo plano), e era o único
// endpoint de upload sem limite de pedidos por hora.
router.post(
  '/video/process',
  authenticate,
  uploadLimiter,
  uploadVideoEdit.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
  ctrl.processVideo
);

// Polling do progresso/resultado do processamento.
router.get('/video/process/:jobId', authenticate, ctrl.getJobStatus);

module.exports = router;
