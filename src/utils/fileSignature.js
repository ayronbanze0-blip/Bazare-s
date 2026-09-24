'use strict';

/**
 * Verificação de "magic bytes" — o tipo real de um ficheiro pelo seu conteúdo,
 * não pelo nome nem pelo Content-Type enviado pelo cliente (ambos falsificáveis).
 * Sem dependências — testável com `node` puro.
 */

const fs = require('fs');

const ascii = (buf, start, end) => buf.toString('latin1', start, end);

function isJpeg(b) { return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; }
function isPng(b) { return b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a; }
function isGif(b) { return b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'); }
function isWebp(b) { return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'; }

// ISO-BMFF (mp4/m4a/mov) — caixa "ftyp" (ou átomos QuickTime antigos) no offset 4.
const ISO_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip']);
function isIsoBmff(b) { return b.length >= 12 && ISO_ATOMS.has(ascii(b, 4, 8)); }
function isEbml(b) { return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3; } // webm/mkv

function isMp3(b) {
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') return true;
  return b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0; // frame sync MPEG
}
function isWav(b) { return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE'; }
function isOgg(b) { return b.length >= 4 && ascii(b, 0, 4) === 'OggS'; }

const CHECKS = {
  image: [isJpeg, isPng, isGif, isWebp],
  video: [isIsoBmff, isEbml],
  audio: [isMp3, isWav, isOgg, isIsoBmff] // m4a/aac em contentor ISO-BMFF; ADTS coberto por isMp3 (sync 0xFFF)
};

/** true se `buf` (primeiros bytes do ficheiro) corresponde à categoria pedida. */
function matchesCategory(buf, category) {
  const checks = CHECKS[category];
  if (!checks || !Buffer.isBuffer(buf)) return false;
  return checks.some((fn) => fn(buf));
}

/** Categoria a partir do Content-Type declarado (só para escolher o que verificar). */
function categoryFromMime(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return null;
}

/** Lê os primeiros 16 bytes de `filePath` e verifica a categoria. Nunca lança. */
function verifyFile(filePath, category, cb) {
  fs.open(filePath, 'r', (err, fd) => {
    if (err) return cb(null, false);
    const buf = Buffer.alloc(16);
    fs.read(fd, buf, 0, 16, 0, (readErr, bytesRead) => {
      fs.close(fd, () => {});
      if (readErr) return cb(null, false);
      cb(null, matchesCategory(buf.subarray(0, bytesRead), category));
    });
  });
}

module.exports = { matchesCategory, categoryFromMime, verifyFile };
