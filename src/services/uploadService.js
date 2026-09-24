'use strict';

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { categoryFromMime, verifyFile } = require('../utils/fileSignature');

// ─── Cloudinary Config ───────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  logger.warn('⚠ Credenciais Cloudinary incompletas — uploads de imagem vão falhar até configurar CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET no .env');
}

// ─── Multer (disk storage, temp) ────────────────────────────────
const uploadsDir = path.join(__dirname, '../../uploads/temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    // Extensão em minúsculas e só com caracteres seguros (o nome original nunca é usado no disco).
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    cb(null, unique + ext);
  }
});

// Depois de o ficheiro chegar ao disco, confirma pelos primeiros bytes ("magic bytes")
// que o CONTEÚDO é mesmo imagem/vídeo/áudio — a extensão e o Content-Type vêm do
// cliente e são falsificáveis. Se não bater, apaga o ficheiro e rejeita (400).
// Está aqui, no storage partilhado, para cobrir TODAS as rotas com upload de uma vez.
const REJECT_MSG = { image: 'Apenas imagens são permitidas (conteúdo do ficheiro inválido).', video: 'Apenas vídeos são permitidos (conteúdo do ficheiro inválido).', audio: 'Apenas áudio é permitido (conteúdo do ficheiro inválido).' };
const storage = {
  _handleFile(req, file, cb) {
    diskStorage._handleFile(req, file, (err, info) => {
      if (err) return cb(err);
      const category = categoryFromMime(file.mimetype);
      verifyFile(info.path, category, (_e, ok) => {
        if (ok) return cb(null, info);
        fs.unlink(info.path, () => {});
        logger.warn(`[Upload] Ficheiro rejeitado (conteúdo não corresponde a ${category}): campo=${file.fieldname}`);
        cb(new Error(REJECT_MSG[category] || 'Apenas imagens são permitidas (conteúdo do ficheiro inválido).'));
      });
    });
  },
  _removeFile(req, file, cb) { diskStorage._removeFile(req, file, cb); }
};

// Listas EXACTAS (antes eram regex sem âncoras: ".jpgx" ou "text/x-jpg" passavam).
const IMAGE_EXT = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg']);
const extOf = (name) => path.extname(String(name || '')).toLowerCase();

const fileFilter = (req, file, cb) => {
  const ext = IMAGE_EXT.has(extOf(file.originalname));
  const mime = IMAGE_MIME.has(String(file.mimetype).toLowerCase());
  if (ext && mime) cb(null, true);
  else cb(new Error('Apenas imagens são permitidas (jpeg, jpg, png, gif, webp)'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 } // 10MB per file, max 20
});

// ─── Multer para vídeo (Histórias em vídeo, Reels) ───────────────
const videoFileFilter = (req, file, cb) => {
  const ext = VIDEO_EXT.has(extOf(file.originalname));
  const mime = VIDEO_MIME.has(String(file.mimetype).toLowerCase());
  if (ext && mime) cb(null, true);
  else cb(new Error('Apenas vídeos são permitidos (mp4, webm, mov)'));
};

// Storage combinado que aceita imagem OU vídeo consoante o nome do
// campo — usado nas Histórias, onde o mesmo endpoint recebe um dos
// dois tipos de ficheiro (nunca ambos na mesma publicação).
const mediaFileFilter = (req, file, cb) => {
  if (file.fieldname === 'video') return videoFileFilter(req, file, cb);
  return fileFilter(req, file, cb);
};

const uploadVideo = multer({
  storage,
  fileFilter: videoFileFilter,
  limits: { fileSize: 60 * 1024 * 1024, files: 1 } // 60MB, um vídeo por pedido
});

const uploadMedia = multer({
  storage,
  fileFilter: mediaFileFilter,
  limits: { fileSize: 60 * 1024 * 1024, files: 1 }
});

// ─── Multer para o EDITOR de vídeo (Fase 3) ───────────────────────
// Recebe o vídeo bruto (antes de cortar/comprimir no servidor) e,
// opcionalmente, uma faixa de áudio a adicionar. O vídeo de entrada
// pode ser maior do que o aceite para publicação directa (60MB)
// porque ainda vai ser cortado e comprimido pelo FFmpeg antes de
// seguir para o Cloudinary — só o resultado final é que respeita o
// limite normal.
const audioFileFilter = (req, file, cb) => {
  const ext = AUDIO_EXT.has(extOf(file.originalname));
  const mime = /^audio\/[a-z0-9.+-]+$/i.test(String(file.mimetype));
  if (ext && mime) cb(null, true);
  else cb(new Error('Apenas áudio é permitido (mp3, m4a, aac, wav, ogg)'));
};

const videoEditFileFilter = (req, file, cb) => {
  if (file.fieldname === 'audio') return audioFileFilter(req, file, cb);
  return videoFileFilter(req, file, cb);
};

const uploadVideoEdit = multer({
  storage,
  fileFilter: videoEditFileFilter,
  limits: { fileSize: 150 * 1024 * 1024, files: 2 } // até 150MB de vídeo bruto + 1 áudio
});

// ─── Multer só para áudio (biblioteca pessoal — POST /media/audio) ─
// Separado de uploadVideoEdit porque aqui é sempre um único ficheiro
// de áudio, guardado uma vez para reutilização futura, nunca junto
// com vídeo no mesmo pedido.
const uploadAudioOnly = multer({
  storage,
  fileFilter: audioFileFilter,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 } // 15MB chega de sobra para 60s de áudio
});

// ─── Erros transitórios (rede/timeout) vs erros definitivos ──────
// Estes valem a pena repetir; erros de auth/validação da Cloudinary não.
const isTransientError = (err) => {
  const code = err.code || '';
  const msg = (err.message || '').toLowerCase();
  return (
    ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('socket hang up')
  );
};

// Mensagem amigável e HONESTA para o utilizador final — nunca inventa
// "sem ligação à Internet" quando o problema é outro (ex.: credenciais
// Cloudinary em falta, ficheiro corrompido, quota excedida, etc.)
const friendlyUploadError = (err) => {
  if (isTransientError(err)) {
    return 'Falha de rede ao enviar a imagem. Tenta novamente.';
  }
  if (err.http_code === 401 || /invalid.*api.*key|api.?secret/i.test(err.message || '')) {
    return 'Erro de configuração do serviço de imagens. Contacta o suporte.';
  }
  if (/file size|too large/i.test(err.message || '')) {
    return 'Imagem demasiado grande.';
  }
  // Nunca devolver a mensagem crua do Cloudinary ao utilizador (fica só no log do servidor).
  return 'Não foi possível processar o ficheiro. Verifica o formato e tenta novamente.';
};

// ─── Upload to Cloudinary (com retry para falhas transitórias) ───
const uploadToCloud = async (localPath, folder = 'bazares/products', attempt = 1) => {
  const MAX_ATTEMPTS = 3;
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder,
      timeout: 60000,
      transformation: [
        { width: 1200, height: 1200, crop: 'limit', quality: 'auto:good' },
        { fetch_format: 'auto' }
      ]
    });
    // Clean up temp file
    fs.unlink(localPath, (err) => {
      if (err) logger.warn(`Could not delete temp file: ${localPath}`);
    });
    return { ok: true, url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    const transient = isTransientError(err);
    if (transient && attempt < MAX_ATTEMPTS) {
      logger.warn(`[Cloudinary] Tentativa ${attempt} falhou (${err.message}) — a repetir...`);
      await new Promise(r => setTimeout(r, attempt * 500)); // backoff: 500ms, 1000ms
      return uploadToCloud(localPath, folder, attempt + 1);
    }
    logger.error(`[Cloudinary] Upload falhou definitivamente após ${attempt} tentativa(s): ${err.message}`);
    fs.unlink(localPath, () => {});
    return { ok: false, error: friendlyUploadError(err), transient };
  }
};

const uploadMany = async (files, folder = 'bazares/products') => {
  const results = await Promise.all(
    files.map(f => uploadToCloud(f.path, folder))
  );
  return results;
};

const deleteFromCloud = async (publicId, resourceType = 'image') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return { ok: true };
  } catch (err) {
    logger.error(`[Cloudinary] Delete failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

// Se o upload para o Cloudinary correu bem mas a escrita na BD falhou, as imagens ficariam
// órfãs (a ocupar quota e sem dono). Apaga-as (fire-and-forget) e volta a lançar o erro.
const cleanupUploaded = (results = []) => {
  for (const r of results) {
    if (r && r.ok && r.publicId) deleteFromCloud(r.publicId).catch(() => {});
  }
};
const withUploadCleanup = async (uploaded, dbWrite) => {
  try {
    return await dbWrite();
  } catch (err) {
    cleanupUploaded(uploaded);
    throw err;
  }
};

const uploadAvatar = async (localPath) =>
  uploadToCloud(localPath, 'bazares/avatars');

const uploadBazarBanner = async (localPath) =>
  uploadToCloud(localPath, 'bazares/banners');

// ─── Upload de vídeo para o Cloudinary (Histórias em vídeo, Reels) ─
// O `eager` abaixo tem de bater CERTINHO com a transformação que o
// frontend pede na entrega (cldVideo() em js/app.js: w_1080,c_limit,
// q_auto:good,f_auto) para o primeiro espectador receber algo já
// pronto em vez de uma transcodificação ao vivo (ver Ronda 19).
//
// `eager_async:false` — espera a transcodificação de entrega (w_1080)
// terminar ANTES de responder. Era `true` para acelerar a publicação,
// mas isso deixava a variante w_1080 "a meio" quando os primeiros
// espectadores abriam o Reel: o Cloudinary serve vídeo em transformação
// on-the-fly por chunks à medida que vai codificando, por isso quem via
// o vídeo nesse intervalo apanhava qualidade a variar dentro do MESMO
// vídeo — nítido nalguns frames, em bloco/desfocado noutros — até o
// eager acabar e ficar em cache. Como este upload já corre dentro de um
// VideoJob em segundo plano (o frontend faz polling até status=DONE e
// só publica depois disso — ver videoEditService.processJob), esperar
// aqui não atrasa nada visível ao vendedor: só adia uns segundos o
// "pronto", e garante que quem vir o Reel a seguir recebe sempre a
// variante w_1080 já pronta e estável, nunca uma transcodificação a
// meio.
const uploadVideoToCloud = async (localPath, folder = 'bazares/reels', attempt = 1) => {
  const MAX_ATTEMPTS = 3;
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder,
      resource_type: 'video',
      timeout: 240000, // era 120000 — agora inclui o tempo do eager síncrono (upload + transcodificação w_1080)
      // quality:'auto:best' (era 'auto:good') — este vídeo já vem
      // comprimido uma vez pelo FFmpeg (videoEditService, crf 19); usar
      // 'good' aqui era uma 2ª compressão agressiva em cima da 1ª,
      // e a soma das duas perdas é que estava a tirar nitidez ao
      // resultado final. TEM de bater certo com o cldVideo() no
      // frontend (js/app.js) — se um dos dois lados mudar sem o outro,
      // o Cloudinary deixa de servir a variante pré-gerada em cache e
      // volta a transcodificar na hora (o bug de qualidade instável
      // dentro do mesmo vídeo que já corrigimos).
      eager: [{ width: 1080, crop: 'limit', quality: 'auto:best', fetch_format: 'mp4' }],
      eager_async: false
    });
    fs.unlink(localPath, (err) => {
      if (err) logger.warn(`Could not delete temp file: ${localPath}`);
    });
    return { ok: true, url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    const transient = isTransientError(err);
    if (transient && attempt < MAX_ATTEMPTS) {
      logger.warn(`[Cloudinary] Tentativa de vídeo ${attempt} falhou (${err.message}) — a repetir...`);
      await new Promise(r => setTimeout(r, attempt * 500));
      return uploadVideoToCloud(localPath, folder, attempt + 1);
    }
    logger.error(`[Cloudinary] Upload de vídeo falhou definitivamente após ${attempt} tentativa(s): ${err.message}`);
    fs.unlink(localPath, () => {});
    return { ok: false, error: friendlyUploadError(err), transient };
  }
};

// ─── Upload de áudio para o Cloudinary (biblioteca pessoal) ────────
// Cloudinary trata áudio como resource_type "video" (sem stream de
// imagem) — não há eager de entrega aqui porque estes ficheiros são
// pequenos (até 15MB / ~60s úteis) e só voltam a ser lidos pelo
// próprio FFmpeg no servidor (videoEditService), nunca servidos
// directamente a um espectador.
const uploadAudioToCloud = async (localPath, folder, attempt = 1) => {
  const MAX_ATTEMPTS = 3;
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder,
      resource_type: 'video',
      timeout: 60000
    });
    fs.unlink(localPath, (err) => {
      if (err) logger.warn(`Could not delete temp file: ${localPath}`);
    });
    return { ok: true, url: result.secure_url, publicId: result.public_id, durationSec: result.duration || 0 };
  } catch (err) {
    const transient = isTransientError(err);
    if (transient && attempt < MAX_ATTEMPTS) {
      logger.warn(`[Cloudinary] Tentativa de áudio ${attempt} falhou (${err.message}) — a repetir...`);
      await new Promise(r => setTimeout(r, attempt * 500));
      return uploadAudioToCloud(localPath, folder, attempt + 1);
    }
    logger.error(`[Cloudinary] Upload de áudio falhou definitivamente após ${attempt} tentativa(s): ${err.message}`);
    fs.unlink(localPath, () => {});
    return { ok: false, error: friendlyUploadError(err), transient };
  }
};

module.exports = {
  upload,
  uploadVideo,
  uploadMedia,
  uploadVideoEdit,
  uploadAudioOnly,
  uploadToCloud,
  uploadVideoToCloud,
  uploadAudioToCloud,
  uploadMany,
  deleteFromCloud,
  cleanupUploaded,
  withUploadCleanup,
  uploadAvatar,
  uploadBazarBanner
};
