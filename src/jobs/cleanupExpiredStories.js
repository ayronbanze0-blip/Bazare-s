'use strict';

// ─────────────────────────────────────────────────────────────────
// Limpeza de stories expiradas (>24h). Antes disto, stories expiradas
// nunca eram apagadas: ficavam para sempre na BD e os seus ficheiros
// (imagem/vídeo/thumbnail) continuavam a ocupar espaço no Cloudinary
// indefinidamente.
//
// Isto corre dentro do mesmo processo Node via setInterval — não é a
// arquitectura ideal (um worker/queue dedicado, como BullMQ+Redis,
// seria mais robusto e sobreviveria a reinícios do processo a meio de
// um lote), mas resolve o crescimento ilimitado de armazenamento sem
// introduzir uma dependência de infraestrutura nova.
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');
const uploadSvc = require('../services/uploadService');

const BATCH_SIZE = 200;

async function cleanupExpiredStories(prisma) {
  try {
    let totalDeleted = 0;
    // Processa em lotes para não carregar milhares de linhas de uma vez
    // nem manter uma transacção longa presa.
    for (;;) {
      const expired = await prisma.story.findMany({
        where: { expiresAt: { lt: new Date() } },
        select: { id: true, imagePublicId: true, videoPublicId: true, thumbnailPublicId: true },
        take: BATCH_SIZE
      });
      if (expired.length === 0) break;

      const ids = expired.map((s) => s.id);
      // onDelete: Cascade já apaga StoryView automaticamente, mas
      // apagamos explicitamente primeiro para não depender só disso.
      await prisma.storyView.deleteMany({ where: { storyId: { in: ids } } }).catch(() => {});
      await prisma.story.deleteMany({ where: { id: { in: ids } } });

      for (const s of expired) {
        if (s.imagePublicId) uploadSvc.deleteFromCloud(s.imagePublicId, 'image').catch(() => {});
        if (s.videoPublicId) uploadSvc.deleteFromCloud(s.videoPublicId, 'video').catch(() => {});
        if (s.thumbnailPublicId) uploadSvc.deleteFromCloud(s.thumbnailPublicId, 'image').catch(() => {});
      }

      totalDeleted += expired.length;
      if (expired.length < BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      logger.info(`[cleanupExpiredStories] ${totalDeleted} stories expiradas removidas.`);
    }
  } catch (err) {
    logger.error(`[cleanupExpiredStories] ${err.message}`);
  }
}

function scheduleStoryCleanup(prisma, intervalMs = 60 * 60 * 1000) {
  // Corre uma vez pouco depois do arranque, e depois de hora a hora.
  setTimeout(() => cleanupExpiredStories(prisma), 30 * 1000);
  return setInterval(() => cleanupExpiredStories(prisma), intervalMs);
}

module.exports = { cleanupExpiredStories, scheduleStoryCleanup };
