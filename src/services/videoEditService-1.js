'use strict';

// ─────────────────────────────────────────────────────────────────
// VIDEO EDIT SERVICE — Fase 3 (editor de vídeo + áudio opcional)
//
// Todo o processamento pesado (corte, capa, mistura/substituição de
// áudio, compressão, geração de thumbnail) corre aqui no servidor
// com FFmpeg, nunca no browser do vendedor. O fluxo:
//
//   1. mediaController.processVideo() valida o pedido, cria um
//      VideoJob (status PENDING) e devolve o id de imediato.
//   2. processJob() corre em segundo plano (fire-and-forget),
//      actualizando `progress`/`status` no VideoJob à medida que o
//      FFmpeg avança.
//   3. O frontend faz polling a GET /api/media/video/process/:id até
//      status=DONE, e só nessa altura publica a História/Reel
//      referenciando o resultado (sem reenviar vídeo nenhum).
// ─────────────────────────────────────────────────────────────────

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const prisma = require('../config/database');
const uploadSvc = require('./uploadService');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ─── Limites de validação ─────────────────────────────────────────
const MAX_INPUT_DURATION_SEC = 180;      // 3 min de vídeo bruto, no máximo
const MAX_OUTPUT_DURATION_SEC = 90;      // corte final não pode passar de 90s (Reel/História)
const MAX_INPUT_SIZE_BYTES = 150 * 1024 * 1024;
const ALLOWED_VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v'];

const tmpFile = (ext) => path.join(os.tmpdir(), `bz-video-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);

const probe = (filePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)));
  });

/**
 * Valida o ficheiro de vídeo bruto antes de aceitar o job: formato,
 * tamanho e duração. Devolve { ok, error, durationSec }.
 */
async function validateInput(filePath, originalname, sizeBytes) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (!ALLOWED_VIDEO_EXT.includes(ext)) {
    return { ok: false, error: 'Formato de vídeo não suportado. Usa MP4, MOV ou WEBM.' };
  }
  if (sizeBytes > MAX_INPUT_SIZE_BYTES) {
    return { ok: false, error: 'Vídeo demasiado grande (máximo 150MB antes de editar).' };
  }
  try {
    const data = await probe(filePath);
    const durationSec = data?.format?.duration ? Math.round(data.format.duration) : null;
    const hasVideoStream = (data.streams || []).some((s) => s.codec_type === 'video');
    if (!hasVideoStream) return { ok: false, error: 'O ficheiro não contém vídeo válido.' };
    if (durationSec && durationSec > MAX_INPUT_DURATION_SEC) {
      return { ok: false, error: `Vídeo demasiado longo (máximo ${MAX_INPUT_DURATION_SEC / 60} minutos antes de cortar).` };
    }
    return { ok: true, durationSec };
  } catch (err) {
    return { ok: false, error: 'Não foi possível ler o vídeo — ficheiro corrompido ou formato inválido.' };
  }
}

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Processa um VideoJob já criado (status PENDING) em segundo plano.
 * Nunca lança — todos os erros ficam registados no próprio job.
 *
 * @param {string} jobId
 * @param {Object} p
 * @param {string} p.inputPath - vídeo bruto (temp, em disco)
 * @param {string} [p.audioPath] - áudio opcional a adicionar (temp, em disco)
 * @param {number} p.trimStart - segundos
 * @param {number} p.trimEnd - segundos
 * @param {number} [p.coverTime] - segundo (relativo ao corte) para extrair a capa; default = meio do corte
 * @param {boolean} p.keepOriginalAudio
 * @param {number} [p.originalVolume=1] - 0..2
 * @param {number} [p.addedVolume=1] - 0..2
 */
async function processJob(jobId, p) {
  const {
    inputPath, audioPath,
    trimStart, trimEnd,
    coverTime,
    keepOriginalAudio,
    originalVolume = 1,
    addedVolume = 1,
    targetFolder
  } = p;

  const cleanupPaths = [inputPath];
  if (audioPath) cleanupPaths.push(audioPath);

  const setJob = (data) =>
    prisma.videoJob.update({ where: { id: jobId }, data }).catch((err) =>
      logger.error(`[VideoEdit] falha a actualizar job ${jobId}: ${err.message}`)
    );

  const fail = async (msg) => {
    logger.error(`[VideoEdit] job ${jobId} falhou: ${msg}`);
    await setJob({ status: 'FAILED', errorMessage: msg.slice(0, 500) });
    cleanupPaths.forEach((f) => fs.unlink(f, () => {}));
  };

  try {
    await setJob({ status: 'PROCESSING', progress: 2 });

    const duration = Math.max(0.5, (Number(trimEnd) || 0) - (Number(trimStart) || 0));
    if (duration > MAX_OUTPUT_DURATION_SEC) {
      return fail(`O corte final não pode passar de ${MAX_OUTPUT_DURATION_SEC} segundos.`);
    }

    const outVideoPath = tmpFile('.mp4');
    const outThumbPath = tmpFile('.jpg');
    cleanupPaths.push(outVideoPath, outThumbPath);

    // ─── 1) Corte + áudio + compressão, tudo num único comando ─────
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputPath)
        .setStartTime(Math.max(0, Number(trimStart) || 0))
        .duration(duration)
        .videoCodec('libx264')
        .outputOptions([
          '-preset veryfast',
          '-crf 19', // era 21 — subido porque este resultado ainda passa por uma 2ª compressão no Cloudinary (eager); 19 dá margem para essa 2ª passagem sem acumular perdas visíveis
          '-movflags +faststart',
          '-vf scale=\'min(1280,iw)\':-2,unsharp=5:5:0.8:5:5:0.0,eq=contrast=1.06:saturation=1.08',
          // era só o scale — acrescentado o mesmo tipo de tratamento que
          // as fotos já têm no editor (image-editor.js: contraste,
          // saturação, nitidez do preset), mas aqui automático, aplicado
          // a TODOS os vídeos sem o vendedor ter de mexer em nada:
          //  - unsharp: realça contornos/detalhe (nitidez) — valores
          //    moderados (0.8) para não criar halos à volta dos bordos
          //  - eq=contrast/saturation: o mesmo "punch" que os presets
          //    de imagem já davam, com valores discretos (+6%/+8%) para
          //    não ficar com aspecto "sobre-editado"
          // Aplicado ANTES da compressão (mesmo -vf), para o unsharp
          // trabalhar sobre o vídeo ainda não comprimido — sharpen
          // depois de comprimir só realçava os blocos de compressão.
          '-pix_fmt yuv420p'
        ]);

      // ─── Áudio: 4 combinações possíveis ───
      if (audioPath && keepOriginalAudio) {
        // mistura: áudio original (cortado ao mesmo intervalo) + áudio adicionado, cada um com o seu volume
        cmd
          .input(audioPath)
          .complexFilter([
            `[0:a]volume=${clampNum(originalVolume, 0, 2, 1)}[a0]`,
            `[1:a]volume=${clampNum(addedVolume, 0, 2, 1)}[a1]`,
            '[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]'
          ])
          .outputOptions(['-map 0:v', '-map [aout]'])
          .audioCodec('aac').audioBitrate('128k');
      } else if (audioPath && !keepOriginalAudio) {
        // substitui totalmente o áudio original pelo adicionado
        cmd
          .input(audioPath)
          .outputOptions(['-map 0:v', '-map 1:a'])
          .audioFilters(`volume=${clampNum(addedVolume, 0, 2, 1)}`)
          .audioCodec('aac').audioBitrate('128k')
          .outputOptions(['-shortest']);
      } else if (!audioPath && keepOriginalAudio) {
        // mantém o áudio original, só ajusta o volume se necessário
        cmd
          .audioFilters(`volume=${clampNum(originalVolume, 0, 2, 1)}`)
          .audioCodec('aac').audioBitrate('128k');
      } else {
        // remove o áudio por completo
        cmd.noAudio();
      }

      cmd
        .on('progress', (info) => {
          // FFmpeg dá tempo processado (não % directa) — convertemos
          // para uma percentagem aproximada usando a duração do corte.
          const pct = info.percent
            ? Math.min(90, Math.round(info.percent))
            : Math.min(90, Math.round(((info.timemark ? toSeconds(info.timemark) : 0) / duration) * 90));
          setJob({ progress: Math.max(2, pct) });
        })
        .on('error', reject)
        .on('end', resolve)
        .save(outVideoPath);
    });

    await setJob({ progress: 92 });

    // ─── 2) Extrai a capa (fotograma escolhido) ─────────────────────
    const coverAt = clampNum(coverTime, 0, duration, duration / 2);
    await new Promise((resolve, reject) => {
      ffmpeg(outVideoPath)
        .on('error', reject)
        .on('end', resolve)
        .screenshots({ timestamps: [coverAt], filename: path.basename(outThumbPath), folder: path.dirname(outThumbPath), size: '720x?' });
    });

    await setJob({ progress: 95 });

    // ─── 3) Upload do vídeo final + capa para o Cloudinary ──────────
    const videoUp = await uploadSvc.uploadVideoToCloud(outVideoPath, targetFolder);
    if (!videoUp.ok) return fail(videoUp.error || 'Falha ao enviar o vídeo processado.');

    const thumbUp = await uploadSvc.uploadToCloud(outThumbPath, `${targetFolder}/covers`);

    fs.unlink(inputPath, () => {});
    if (audioPath) fs.unlink(audioPath, () => {});
    fs.unlink(outThumbPath, () => {}); // uploadToCloud já apaga o outVideoPath/outThumbPath em sucesso; isto cobre falhas parciais

    await setJob({
      status: 'DONE',
      progress: 100,
      resultUrl: videoUp.url,
      resultPublicId: videoUp.publicId,
      thumbnailUrl: thumbUp.ok ? thumbUp.url : null,
      thumbnailPublicId: thumbUp.ok ? thumbUp.publicId : null,
      durationSec: Math.round(duration)
    });
  } catch (err) {
    await fail(err.message || 'Erro desconhecido a processar o vídeo.');
  }
}

function toSeconds(timemark) {
  // "00:00:12.34" -> 12.34
  const parts = String(timemark).split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

module.exports = { validateInput, processJob, MAX_OUTPUT_DURATION_SEC, MAX_INPUT_DURATION_SEC };
