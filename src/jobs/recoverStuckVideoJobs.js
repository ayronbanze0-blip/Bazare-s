'use strict';

// ─────────────────────────────────────────────────────────────────
// O processamento de vídeo (videoEditService.processJob) corre com
// setImmediate() no MESMO processo Node que serve a API — se o Render
// reiniciar o processo a meio de um job (deploy, crash, restart de
// rotina), o VideoJob fica preso em PENDING/PROCESSING para sempre: o
// ficheiro temporário desapareceu com o processo antigo, e nada vai
// retomar ou marcar esse job como falhado. O frontend, que faz
// polling à espera de status=DONE, fica à espera indefinidamente.
//
// Isto não substitui uma fila persistente real (BullMQ+Redis, Cloud
// Tasks) — não retoma o processamento, só evita o "preso para
// sempre": jobs parados há muito tempo são marcados FAILED para o
// vendedor poder tentar de novo.
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');

const STUCK_AFTER_MS = 20 * 60 * 1000; // 20 minutos é generoso para qualquer vídeo dentro dos limites do editor

async function recoverStuckVideoJobs(prisma) {
  try {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const result = await prisma.videoJob.updateMany({
      where: { status: { in: ['PENDING', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
      data: { status: 'FAILED', errorMessage: 'O processamento foi interrompido (reinício do servidor). Tente novamente.' }
    });
    if (result.count > 0) {
      logger.warn(`[recoverStuckVideoJobs] ${result.count} VideoJob(s) presos marcados como FAILED.`);
    }
  } catch (err) {
    logger.error(`[recoverStuckVideoJobs] ${err.message}`);
  }
}

function scheduleVideoJobRecovery(prisma, intervalMs = 10 * 60 * 1000) {
  // Corre logo no arranque também — é exactamente o momento em que jobs
  // órfãos de uma instância anterior mais precisam de ser limpos.
  setTimeout(() => recoverStuckVideoJobs(prisma), 15 * 1000);
  return setInterval(() => recoverStuckVideoJobs(prisma), intervalMs);
}

module.exports = { recoverStuckVideoJobs, scheduleVideoJobRecovery };
