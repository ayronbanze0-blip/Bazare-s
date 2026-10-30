'use strict';

/**
 * Limpa ficheiros temporários esquecidos (uploads interrompidos, ffmpeg que falhou a meio, cliente
 * que desligou durante o envio). Sem isto, o disco do servidor enche devagar durante semanas de uptime.
 * Só toca em ficheiros antigos (>2 h) das nossas pastas/prefixos — nunca em ficheiros recentes em uso.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');
const { noOverlap } = require('../utils/noOverlap');

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const UPLOADS_TMP = path.join(__dirname, '../../uploads/temp');

/** Apaga ficheiros (não pastas) de `dir` com mais de `maxAgeMs`, opcionalmente só com um prefixo. */
async function sweepDir(dir, { maxAgeMs = MAX_AGE_MS, prefix = '', now = Date.now() } = {}) {
  let removed = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; } // pasta não existe
  for (const e of entries) {
    if (!e.isFile() || (prefix && !e.name.startsWith(prefix))) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > maxAgeMs) { await fs.promises.unlink(full); removed++; }
    } catch { /* ficheiro desapareceu entretanto — ignora */ }
  }
  return removed;
}

const run = noOverlap(async () => {
  try {
    const n = (await sweepDir(UPLOADS_TMP)) + (await sweepDir(os.tmpdir(), { prefix: 'bz-video-' }));
    if (n > 0) logger.info(`[tempSweeper] ${n} ficheiro(s) temporário(s) antigo(s) removido(s).`);
  } catch (err) {
    logger.warn(`[tempSweeper] ${err.message}`);
  }
});

function scheduleTempSweeper() {
  const timers = [setTimeout(run, 5 * 60 * 1000), setInterval(run, 60 * 60 * 1000)];
  timers.forEach((t) => t.unref && t.unref());
  return timers;
}

module.exports = { scheduleTempSweeper, sweepDir };
