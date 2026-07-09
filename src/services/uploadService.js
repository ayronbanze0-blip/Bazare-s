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

module.exports = {
  upload,
  uploadToCloud,
  uploadMany,
  deleteFromCloud,
  uploadAvatar,
  uploadBazarBanner
};
