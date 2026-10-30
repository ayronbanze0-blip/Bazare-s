'use strict';

/**
 * Hash/compare de passwords e PINs SEM bloquear o servidor.
 *
 * `bcryptjs` é JavaScript puro: com 12 rondas cada hash gasta ~250–600 ms de CPU na thread principal e,
 * durante esse tempo, NENHUM outro pedido é atendido. Num pico de registos/logins (dia de lançamento)
 * isso congela a API toda. Aqui o cálculo corre num worker_thread; a thread principal continua livre.
 *
 *  - Mesma API que o bcryptjs (`hash(pw, rounds)`, `compare(pw, hash)`) e mesmo formato de hash →
 *    não é preciso migrar nada na BD nem mexer em passwords existentes.
 *  - Sem dependências novas (não mexe no package-lock).
 *  - PASSWORD_WORKERS (default 1; mais do que os núcleos do servidor não ajuda).
 *  - Fila limitada: se houver pedidos demais à espera, falha depressa (503) em vez de acumular.
 *  - Se o worker não arrancar/morrer, cai para bcryptjs normal — nunca deixa de funcionar.
 */
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_QUEUE = parseInt(process.env.PASSWORD_QUEUE_MAX, 10) || 200;
const SIZE = Math.max(1, Math.min(parseInt(process.env.PASSWORD_WORKERS, 10) || 1, 4));
const DISABLED = process.env.PASSWORD_WORKERS === '0'; // desliga (ex.: testes, debugging)

let bcryptInline; // carregado só se for preciso (fallback)
const inline = () => (bcryptInline ||= require('bcryptjs'));

class BusyError extends Error {
  constructor() { super('Servidor ocupado. Tente novamente dentro de instantes.'); this.name = 'BusyError'; this.status = 503; }
}

const workers = []; // { w, busy:Map<id,{resolve,reject}> }
let nextId = 1;
let broken = false;

function spawn() {
  const slot = { busy: new Map(), w: null };
  const w = new Worker(path.join(__dirname, '../workers/bcryptWorker.js'));
  w.on('message', ({ id, result, error }) => {
    const p = slot.busy.get(id); if (!p) return;
    slot.busy.delete(id);
    if (slot.busy.size === 0) w.unref(); // ocioso → não segura o processo
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  const dead = () => {
    const pending = [...slot.busy.values()]; slot.busy.clear();
    const i = workers.indexOf(slot); if (i >= 0) workers.splice(i, 1);
    pending.forEach((p) => p.reject(new Error('worker terminou')));
  };
  w.on('error', dead);
  w.on('exit', dead);
  slot.w = w;
  // Ocioso = unref (nunca impede o processo de terminar). Só fica "ref" enquanto houver pedidos pendentes,
  // para o processo não sair a meio de um hash. (unref DEPOIS de registar listeners: um 'message' volta a dar ref.)
  w.unref();
  return slot;
}

function pick() {
  if (DISABLED || broken) return null;
  try {
    while (workers.length < SIZE) workers.push(spawn());
  } catch { broken = true; return null; }
  // o worker com menos trabalho pendente
  return workers.reduce((a, b) => (b.busy.size < a.busy.size ? b : a));
}

function run(op, args) {
  const slot = pick();
  if (!slot) return inline()[op](...args); // fallback
  const pending = workers.reduce((n, s) => n + s.busy.size, 0);
  if (pending >= MAX_QUEUE) return Promise.reject(new BusyError());
  const id = nextId++;
  return new Promise((resolve, reject) => {
    slot.busy.set(id, { resolve, reject });
    slot.w.ref();
    slot.w.postMessage({ id, op, args });
  }).catch((err) => {
    if (err.message === 'worker terminou') return inline()[op](...args); // worker caiu: refaz aqui
    throw err;
  });
}

const hash = (password, rounds) => run('hash', [password, rounds]);
const compare = (password, hashed) => run('compare', [password, hashed]);

module.exports = { hash, compare, BusyError };
