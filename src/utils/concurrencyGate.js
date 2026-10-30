'use strict';

/**
 * Limita quantas tarefas pesadas correm AO MESMO TEMPO (as restantes esperam em fila).
 * Usado na edição de vídeo: o ffmpeg gasta muita RAM/CPU e, num servidor pequeno, 4–5 edições em paralelo
 * esgotam a memória e o sistema mata o processo — a API INTEIRA cai por causa de um vídeo.
 */
class GateFullError extends Error {
  constructor() { super('Fila cheia.'); this.name = 'GateFullError'; }
}

function createGate({ max = 1, maxQueue = 20 } = {}) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    run(fn) {
      if (active >= max && waiting.length >= maxQueue) return Promise.reject(new GateFullError());
      return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
    },
    stats: () => ({ active, waiting: waiting.length })
  };
}

module.exports = { createGate, GateFullError };
