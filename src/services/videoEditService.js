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

// Traduz "9:16" etc. numa expressão de crop centrado, em função das
// dimensões reais de entrada (iw/ih) — o FFmpeg resolve isto em tempo
// de execução, por isso não precisamos de saber a resolução aqui.
const ASPECT_RATIOS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };
function buildCropFilter(aspect) {
  const r = ASPECT_RATIOS[aspect];
  if (!r) return null;
  // Escolhe o maior rectângulo com a proporção `r` que cabe no frame,
  // e centra-o — o mesmo comportamento que um "crop para caber" no
  // editor de fotos já dá ao vendedor.
  return `crop='if(gt(a,${r}),ih*${r},iw)':'if(gt(a,${r}),ih,iw/${r})'`;
}

/**
 * Monta a cadeia -vf (filtros de vídeo) num único filtro combinado.
 * Mantém sempre o "punch" subtil (contraste/saturação/nitidez) que já
 * era aplicado a todos os vídeos automaticamente — os ajustes do
 * vendedor (brightness/contrast/saturation) somam-se a essa base em
 * vez de a substituir, para não perder a consistência visual entre
 * publicações que não mexem em nada.
 */
function buildVideoFilterChain({ rotation, aspect, brightness, contrast, saturation, speed }) {
  const filters = [];

  if (rotation === 90) filters.push('transpose=1');
  else if (rotation === 180) filters.push('transpose=1,transpose=1');
  else if (rotation === 270) filters.push('transpose=2');

  const cropFilter = buildCropFilter(aspect);
  if (cropFilter) filters.push(cropFilter);

  filters.push("scale='min(1280,iw)':-2");
  filters.push('unsharp=5:5:0.8:5:5:0.0');

  const finalContrast = clampNum(1.06 * (1 + (contrast || 0)), 0.3, 3, 1.06);
  const finalSaturation = clampNum(1.08 * (1 + (saturation || 0)), 0, 3, 1.08);
  const finalBrightness = clampNum(brightness || 0, -1, 1, 0);
  filters.push(`eq=contrast=${finalContrast.toFixed(3)}:saturation=${finalSaturation.toFixed(3)}:brightness=${finalBrightness.toFixed(3)}`);

  if (speed && speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);

  return filters.join(',');
}

/**
 * Processa um VideoJob já criado (status PENDING) em segundo plano.
 * Nunca lança — todos os erros ficam registados no próprio job.
 *
 * @param {string} jobId
 * @param {Object} p
 * @param {string} p.inputPath - vídeo bruto (temp, em disco)
 * @param {string} [p.audioUrl] - URL (Cloudinary) do áudio da biblioteca pessoal a adicionar
 * @param {number} [p.musicStart] - segundos, início do troço de áudio a usar
 * @param {number} [p.musicEnd] - segundos, fim do troço (máx. 60s de troço, já validado no controller)
 * @param {number} p.trimStart - segundos
 * @param {number} p.trimEnd - segundos
 * @param {number} [p.coverTime] - segundo (relativo ao corte, timeline de entrada) para extrair a capa; default = meio do corte
 * @param {boolean} p.keepOriginalAudio
 * @param {number} [p.originalVolume=1] - 0..2
 * @param {number} [p.addedVolume=1] - 0..2
 * @param {number} [p.rotation=0] - 0, 90, 180 ou 270
 * @param {number} [p.brightness=0] - -1..1
 * @param {number} [p.contrast=0] - -1..1
 * @param {number} [p.saturation=0] - -1..1
 * @param {number} [p.speed=1] - 0.5..2
 * @param {string|null} [p.aspect] - "9:16" | "1:1" | "4:5" | "16:9" | null (proporção original)
 */
async function processJob(jobId, p) {
  const {
    inputPath,
    audioUrl, musicStart = 0, musicEnd = 0,
    trimStart, trimEnd,
    coverTime,
    keepOriginalAudio,
    originalVolume = 1,
    addedVolume = 1,
    rotation = 0, brightness = 0, contrast = 0, saturation = 0, speed = 1, aspect = null,
    targetFolder
  } = p;

  const cleanupPaths = [inputPath];

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
    const speedSafe = clampNum(speed, 0.5, 2, 1);
    const outputDuration = duration / speedSafe; // é isto que sai no ficheiro final, se a velocidade mudar

    const outVideoPath = tmpFile('.mp4');
    const outThumbPath = tmpFile('.jpg');
    cleanupPaths.push(outVideoPath, outThumbPath);

    const hasAddedAudio = !!audioUrl;
    const musicClipLen = Math.max(0.5, (musicEnd || 0) - (musicStart || 0));

    // ─── 1) Corte + ajustes + áudio + compressão, tudo num único comando ─
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputPath)
        .setStartTime(Math.max(0, Number(trimStart) || 0))
        .duration(duration)
        .videoCodec('libx264')
        .outputOptions([
          '-preset veryfast',
          '-crf 19', // era 21 — subido porque este resultado ainda passa por uma 2ª compressão no Cloudinary (eager); 19 dá margem para essa 2ª passagem sem acumular perdas visíveis
          '-movflags +faststart',
          `-vf ${buildVideoFilterChain({ rotation, aspect, brightness, contrast, saturation, speed: speedSafe })}`,
          // scale + unsharp + eq: o mesmo tipo de tratamento que as fotos
          // já têm no editor (image-editor.js: contraste, saturação,
          // nitidez do preset), aplicado a TODOS os vídeos sem o vendedor
          // ter de mexer em nada — rotação/proporção/ajustes do vendedor
          // (se os usar) somam-se a esta base, ver buildVideoFilterChain.
          '-pix_fmt yuv420p'
        ]);

      // ─── Áudio: 4 combinações possíveis ───
      if (hasAddedAudio && keepOriginalAudio) {
        // mistura: áudio original (cortado ao mesmo intervalo) + troço
        // escolhido do áudio da biblioteca, cada um com o seu volume.
        // O áudio da biblioteca entra como input remoto (URL do
        // Cloudinary) — o FFmpeg descarrega-o directamente, sem
        // precisarmos de o pôr em disco aqui.
        cmd
          .input(audioUrl)
          .inputOptions(['-ss', String(musicStart), '-t', String(musicClipLen)])
          .complexFilter([
            `[0:a]volume=${clampNum(originalVolume, 0, 2, 1)}${speedSafe !== 1 ? `,atempo=${speedSafe}` : ''}[a0]`,
            `[1:a]asetpts=PTS-STARTPTS,volume=${clampNum(addedVolume, 0, 2, 1)}${speedSafe !== 1 ? `,atempo=${speedSafe}` : ''}[a1]`,
            '[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]'
          ])
          .outputOptions(['-map 0:v', '-map [aout]'])
          .audioCodec('aac').audioBitrate('128k');
      } else if (hasAddedAudio && !keepOriginalAudio) {
        // substitui totalmente o áudio original pelo troço da biblioteca
        const addedAudioFilters = [`atrim=0:${musicClipLen}`, 'asetpts=PTS-STARTPTS', `volume=${clampNum(addedVolume, 0, 2, 1)}`];
        if (speedSafe !== 1) addedAudioFilters.push(`atempo=${speedSafe}`);
        cmd
          .input(audioUrl)
          .inputOptions(['-ss', String(musicStart), '-t', String(musicClipLen)])
          .outputOptions(['-map 0:v', '-map 1:a'])
          .audioFilters(addedAudioFilters.join(','))
          .audioCodec('aac').audioBitrate('128k')
          .outputOptions(['-shortest']);
      } else if (!hasAddedAudio && keepOriginalAudio) {
        // mantém o áudio original, só ajusta o volume (e a velocidade, se mudou)
        const origAudioFilters = [`volume=${clampNum(originalVolume, 0, 2, 1)}`];
        if (speedSafe !== 1) origAudioFilters.push(`atempo=${speedSafe}`);
        cmd
          .audioFilters(origAudioFilters.join(','))
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
    // coverTime vem na timeline de ENTRADA (antes de qualquer alteração
    // de velocidade) — se a velocidade mudou, o mesmo instante cai
    // noutro ponto do ficheiro final (setpts=(1/speed)*PTS desloca os
    // tempos), por isso convertemos aqui.
    const coverAtInput = clampNum(coverTime, 0, duration, duration / 2);
    const coverAt = clampNum(coverAtInput / speedSafe, 0, outputDuration, outputDuration / 2);
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
    fs.unlink(outThumbPath, () => {}); // uploadToCloud já apaga o outVideoPath/outThumbPath em sucesso; isto cobre falhas parciais

    await setJob({
      status: 'DONE',
      progress: 100,
      resultUrl: videoUp.url,
      resultPublicId: videoUp.publicId,
      thumbnailUrl: thumbUp.ok ? thumbUp.url : null,
      thumbnailPublicId: thumbUp.ok ? thumbUp.publicId : null,
      durationSec: Math.round(outputDuration)
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

// ─── Compressão de áudio para a biblioteca pessoal ─────────────────
// Chamado uma vez, quando um áudio novo é guardado (mediaController.
// uploadAudio) — nunca no momento de publicar, já que o ficheiro
// guardado é reutilizado várias vezes depois. Normaliza qualquer
// formato de origem (mp3/wav/m4a/aac/ogg) para AAC 128kbps: um WAV de
// 60s pode pesar ~10MB sem compressão nenhuma, contra ~1MB depois
// disto — a diferença conta tanto para o espaço no Cloudinary como
// para os dados móveis do vendedor a enviar.
function compressAudioForLibrary(inputPath) {
  const outPath = tmpFile('.m4a');
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo() // alguns ficheiros de origem trazem uma capa embutida como "faixa de vídeo" — descartada, só interessa o som
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioChannels(2)
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

module.exports = { validateInput, processJob, compressAudioForLibrary, MAX_OUTPUT_DURATION_SEC, MAX_INPUT_DURATION_SEC };
