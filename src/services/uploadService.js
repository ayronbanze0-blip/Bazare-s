'use strict';

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  const mime = allowed.test(file.mimetype);
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
  const allowedExt = /mp4|webm|mov|quicktime/;
  const allowedMime = /video\/(mp4|webm|quicktime)/;
  const ext = allowedExt.test(path.extname(file.originalname).toLowerCase());
  const mime = allowedMime.test(file.mimetype);
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
  const allowedExt = /mp3|m4a|aac|wav|ogg/;
  const allowedMime = /audio\//;
  const ext = allowedExt.test(path.extname(file.originalname).toLowerCase());
  const mime = allowedMime.test(file.mimetype);
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
  return `Não foi possível processar a imagem (${err.message || 'erro desconhecido'}).`;
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

const deleteFromCloud = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    return { ok: true };
  } catch (err) {
    logger.error(`[Cloudinary] Delete failed: ${err.message}`);
    return { ok: false, error: err.message };
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

module.exports = {
  upload,
  uploadVideo,
  uploadMedia,
  uploadVideoEdit,
  uploadToCloud,
  uploadVideoToCloud,
  uploadMany,
  deleteFromCloud,
  uploadAvatar,
  uploadBazarBanner
};
