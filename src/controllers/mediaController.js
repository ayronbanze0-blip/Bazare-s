'use strict';

const { ok, created, accepted, notFound, forbidden, serverError, badRequest } = require('../utils/response');
const logger = require('../utils/logger');
const prisma = require('../config/database');
const videoEditSvc = require('../services/videoEditService');
const uploadSvc = require('../services/uploadService');
const fs = require('fs');

const ALLOWED_TARGETS = { stories: 'bazares/stories', reels: 'bazares/reels' };
const MAX_AUDIO_CLIP_SEC = 60; // pedido do vendedor: nunca mais do que isto por corte de música

// ─── POST /api/media/video/process ─────────────────────────────────
// Recebe o vídeo bruto + os parâmetros de edição escolhidos no editor
// (corte, capa, ajustes visuais, música). Valida rapidamente, cria o
// VideoJob e devolve o id de imediato — o corte/mistura/compressão
// pesados correm a seguir, em segundo plano, no servidor.
//
// Música: já não vem como ficheiro solto neste pedido — o vendedor
// escolhe da biblioteca pessoal dele (UserAudio, ver uploadAudio
// abaixo) e só envia `audioId`. Isto evita subir o mesmo ficheiro de
// áudio outra vez em cada publicação nova.
const processVideo = async (req, res) => {
  const videoFile = req.files?.video?.[0];

  const cleanup = () => {
    if (videoFile) fs.unlink(videoFile.path, () => {});
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

    // ─── Música da biblioteca pessoal (opcional) ──────────────────
    let audioUrl = null;
    let musicStart = 0;
    let musicEnd = 0;
    if (req.body.audioId) {
      const track = await prisma.userAudio.findFirst({
        where: { id: req.body.audioId, userId: req.user.id }
      });
      if (!track) { cleanup(); return badRequest(res, 'Áudio não encontrado na tua biblioteca.'); }

      musicStart = Math.max(0, Number(req.body.musicStart) || 0);
      musicEnd = Number(req.body.musicEnd);
      if (!Number.isFinite(musicEnd) || musicEnd <= musicStart) musicEnd = Math.min(track.durationSec || musicStart + 1, musicStart + (trimEnd - trimStart));
      if (musicEnd - musicStart > MAX_AUDIO_CLIP_SEC) musicEnd = musicStart + MAX_AUDIO_CLIP_SEC;
      audioUrl = track.audioUrl;
    }

    const keepOriginalAudio = String(req.body.keepOriginalAudio ?? 'true') === 'true';
    const originalVolume = req.body.originalVolume !== undefined ? Number(req.body.originalVolume) : 1;
    // musicVolume é o nome novo (vindo do editor); addedVolume fica como
    // alias de compatibilidade caso algum cliente antigo ainda o envie.
    const addedVolume = req.body.musicVolume !== undefined ? Number(req.body.musicVolume)
      : req.body.addedVolume !== undefined ? Number(req.body.addedVolume) : 1;
    const coverTime = req.body.coverTime !== undefined ? Number(req.body.coverTime) : undefined;

    // ─── Ajustes visuais (opcionais, todos com omissão neutra) ────
    const rotation = [0, 90, 180, 270].includes(Number(req.body.rotation)) ? Number(req.body.rotation) : 0;
    const brightness = req.body.brightness !== undefined ? Number(req.body.brightness) : 0;
    const contrast = req.body.contrast !== undefined ? Number(req.body.contrast) : 0;
    const saturation = req.body.saturation !== undefined ? Number(req.body.saturation) : 0;
    const speed = req.body.speed !== undefined ? Number(req.body.speed) : 1;
    const aspect = ['9:16', '1:1', '4:5', '16:9'].includes(req.body.aspect) ? req.body.aspect : null;

    const job = await prisma.videoJob.create({
      data: { userId: req.user.id, status: 'PENDING', progress: 0, targetFolder: target }
    });

    // Corre em segundo plano — a resposta HTTP não espera pelo FFmpeg.
    // O frontend faz polling a GET /video/process/:id até status=DONE.
    setImmediate(() => {
      videoEditSvc
        .processJob(job.id, {
          inputPath: videoFile.path,
          audioUrl, musicStart, musicEnd,
          trimStart, trimEnd, coverTime,
          keepOriginalAudio, originalVolume, addedVolume,
          rotation, brightness, contrast, saturation, speed, aspect,
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

// ─── GET /api/media/audio ───────────────────────────────────────────
// Biblioteca pessoal de áudios já usados — mais recentes primeiro.
const listAudio = async (req, res) => {
  try {
    const audios = await prisma.userAudio.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return ok(res, { audios });
  } catch (err) {
    logger.error(`[Media.listAudio] ${err.message}`);
    return serverError(res);
  }
};

// ─── POST /api/media/audio ──────────────────────────────────────────
// Sobe um áudio novo UMA ÚNICA VEZ para a biblioteca pessoal do
// vendedor. Chamado pelo editor de vídeo só quando o ficheiro
// escolhido ainda não tem `audioId` (ver ensureVeAudioUploaded no
// frontend) — publicações seguintes reutilizam o registo criado
// aqui sem novo upload.
const uploadAudio = async (req, res) => {
  const audioFile = req.file;
  const cleanup = () => { if (audioFile) fs.unlink(audioFile.path, () => {}); };

  try {
    if (!audioFile) return badRequest(res, 'Nenhum áudio enviado.');

    // Compressão: normaliza qualquer formato de origem para AAC
    // 128kbps antes de subir — o mesmo tratamento que o vídeo já tem.
    // Se a compressão falhar por algum motivo, sobe-se o ficheiro
    // original em vez de bloquear o upload (nunca vale a pena perder
    // um áudio válido por causa de um passo de optimização).
    let uploadPath = audioFile.path;
    try {
      uploadPath = await videoEditSvc.compressAudioForLibrary(audioFile.path);
    } catch (e) {
      logger.warn(`[Media.uploadAudio] compressão falhou, a subir o ficheiro original: ${e.message}`);
    } finally {
      if (uploadPath !== audioFile.path) fs.unlink(audioFile.path, () => {});
    }

    const up = await uploadSvc.uploadAudioToCloud(uploadPath, `bazares/user-audio/${req.user.id}`);
    if (!up.ok) return serverError(res, up.error);

    const saved = await prisma.userAudio.create({
      data: {
        userId: req.user.id,
        title: (req.body.title || audioFile.originalname || 'Áudio').slice(0, 120),
        audioUrl: up.url,
        cloudinaryId: up.publicId,
        durationSec: up.durationSec || 0
      }
    });

    return created(res, { audio: saved }, 'Áudio guardado na tua biblioteca.');
  } catch (err) {
    cleanup();
    logger.error(`[Media.uploadAudio] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/media/audio/:id ────────────────────────────────────
const deleteAudio = async (req, res) => {
  try {
    const item = await prisma.userAudio.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!item) return notFound(res, 'Áudio não encontrado.');

    await uploadSvc.deleteFromCloud(item.cloudinaryId, 'video').catch(() => {});
    await prisma.userAudio.delete({ where: { id: item.id } });

    return ok(res, {}, 'Áudio removido da biblioteca.');
  } catch (err) {
    logger.error(`[Media.deleteAudio] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { processVideo, getJobStatus, listAudio, uploadAudio, deleteAudio };
