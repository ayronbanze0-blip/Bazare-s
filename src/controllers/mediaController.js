'use strict';

const { ok, accepted, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const logger = require('../utils/logger');
const prisma = require('../config/database');
const videoEditSvc = require('../services/videoEditService');
const fs = require('fs');

const ALLOWED_TARGETS = { stories: 'bazares/stories', reels: 'bazares/reels' };

// ─── POST /api/media/video/process ─────────────────────────────────
// Recebe o vídeo bruto (+ áudio opcional) e os parâmetros de edição
// escolhidos no editor (corte, capa, áudio). Valida rapidamente,
// cria o VideoJob e devolve o id de imediato — o corte/mistura/
// compressão pesados correm a seguir, em segundo plano, no servidor.
const processVideo = async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const audioFile = req.files?.audio?.[0];

  const cleanup = () => {
    if (videoFile) fs.unlink(videoFile.path, () => {});
    if (audioFile) fs.unlink(audioFile.path, () => {});
  };

  try {
    if (!videoFile) { cleanup(); return badRequest(res, 'Nenhum vídeo enviado.'); }

    const target = ALLOWED_TARGETS[String(req.body.target || '').toLowerCase()];
    if (!target) { cleanup(); return badRequest(res, 'Destino inválido (usa "stories" ou "reels").'); }

    const trimStart = Number(req.body.trimStart);
    const trimEnd = Number(req.body.trimEnd);
    if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd) || trimEnd <= trimStart) {
      cleanup();
      return badRequest(res, 'Intervalo de corte inválido.');
    }
    if (trimEnd - trimStart > videoEditSvc.MAX_OUTPUT_DURATION_SEC) {
      cleanup();
      return badRequest(res, `O corte não pode passar de ${videoEditSvc.MAX_OUTPUT_DURATION_SEC} segundos.`);
    }

    const validation = await videoEditSvc.validateInput(videoFile.path, videoFile.originalname, videoFile.size);
    if (!validation.ok) { cleanup(); return badRequest(res, validation.error); }

    const keepOriginalAudio = String(req.body.keepOriginalAudio ?? 'true') === 'true';
    const originalVolume = req.body.originalVolume !== undefined ? Number(req.body.originalVolume) : 1;
    const addedVolume = req.body.addedVolume !== undefined ? Number(req.body.addedVolume) : 1;
    const coverTime = req.body.coverTime !== undefined ? Number(req.body.coverTime) : undefined;

    const job = await prisma.videoJob.create({
      data: { userId: req.user.id, status: 'PENDING', progress: 0, targetFolder: target }
    });

    // Corre em segundo plano — a resposta HTTP não espera pelo FFmpeg.
    // O frontend faz polling a GET /video/process/:id até status=DONE.
    setImmediate(() => {
      videoEditSvc
        .processJob(job.id, {
          inputPath: videoFile.path,
          audioPath: audioFile ? audioFile.path : null,
          trimStart, trimEnd, coverTime,
          keepOriginalAudio, originalVolume, addedVolume,
          targetFolder: target
        })
        .catch((err) => logger.error(`[Media.processVideo] job ${job.id} rebentou: ${err.message}`));
    });

    return accepted(res, { jobId: job.id, status: job.status }, 'Vídeo em processamento.');
  } catch (err) {
    cleanup();
    logger.error(`[Media.processVideo] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/media/video/process/:jobId ───────────────────────────
const getJobStatus = async (req, res) => {
  try {
    const job = await prisma.videoJob.findUnique({ where: { id: req.params.jobId } });
    if (!job) return notFound(res, 'Job não encontrado.');
    if (job.userId !== req.user.id) return forbidden(res);

    return ok(res, {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      resultUrl: job.resultUrl,
      thumbnailUrl: job.thumbnailUrl,
      durationSec: job.durationSec,
      error: job.errorMessage || null
    });
  } catch (err) {
    logger.error(`[Media.getJobStatus] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { processVideo, getJobStatus };
