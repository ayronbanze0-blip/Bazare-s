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

// ─── Upload to Cloudinary ────────────────────────────────────────
const uploadToCloud = async (localPath, folder = 'bazares/products') => {
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder,
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
    logger.error(`[Cloudinary] Upload failed: ${err.message}`);
    fs.unlink(localPath, () => {});
    return { ok: false, error: err.message };
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
