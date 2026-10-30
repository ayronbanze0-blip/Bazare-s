'use strict';

/**
 * Impede que a mesma tarefa corra duas vezes ao mesmo tempo no mesmo processo
 * (ex.: um job de 30 min que demora mais de 30 min e se sobrepõe ao seguinte).
 * Se já estiver a correr, a chamada nova é ignorada (devolve undefined).
 */
function noOverlap(fn, { onSkip } = {}) {
  let running = false;
  return async function guarded(...args) {
    if (running) { if (onSkip) onSkip(); return undefined; }
    running = true;
    try { return await fn(...args); } finally { running = false; }
  };
}

module.exports = { noOverlap };
