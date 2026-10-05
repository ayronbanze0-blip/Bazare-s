'use strict';
// Regressão de segurança do chat em tempo real (sem dependências instaladas: usa stubs).
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const calls = [];
const origLoad = Module._load;
const stubs = (name) => {
  if (name === 'jsonwebtoken') return { verify: () => ({ id: 'u1', name: 'T' }) };
  if (/utils\/logger$/.test(name)) return { info() {}, warn() {}, error: (m) => calls.push('ERR:' + m) };
  if (/utils\/helpers$/.test(name)) return { sanitize: (x) => x };
  if (/notificationService$|aiService$|blockService$/.test(name)) {
    return { newMessage() {}, isBlockedEither: async () => false, bazarBotReply: async () => ({ text: 'x' }) };
  }
  if (/config\/database$/.test(name)) {
    return {
      user: { findUnique: async () => ({ active: true, role: 'BUYER' }), findFirst: async () => null },
      chat: {
        findUnique: async ({ where }) => (where.id === 'c1' ? { userAId: 'u1', userBId: 'u2' } : { userAId: 'x', userBId: 'y' }),
        update: async () => {}
      },
      message: {
        updateMany: async () => { calls.push('UPDATEMANY'); return {}; },
        create: async (a) => ({ id: 'm', ...a.data }),
        findUnique: async () => null
      }
    };
  }
  return undefined;
};
Module._load = function (req, parent, isMain) {
  const r = stubs(req);
  return r !== undefined ? r : origLoad.apply(this, arguments);
};
const { setupSocket } = require('../../src/sockets/chatSocket');
Module._load = origLoad;

const handlers = {};
const socket = {
  user: { id: 'u1', name: 'T' }, handshake: { auth: { token: 't' } }, rooms: new Set(),
  join(r) { this.rooms.add(r); }, leave() {}, on(e, f) { handlers[e] = f; },
  emit(e) { calls.push('EMIT:' + e); }, to() { return { emit(e) { calls.push('BROADCAST:' + e); } }; }
};
setupSocket({ use() {}, on(e, f) { if (e === 'connection') f(socket); }, emit() {}, to() { return { emit() {} }; } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const EVENTS = ['chat:join', 'chat:leave', 'message:send', 'typing:start', 'typing:stop', 'messages:read', 'presence:check'];

test('eventos sem payload / com payload inválido não deitam o processo abaixo', async () => {
  for (const ev of EVENTS) {
    assert.doesNotThrow(() => { handlers[ev](); handlers[ev](null); handlers[ev]('lixo'); handlers[ev]([1]); });
  }
  await tick();
});
test('messages:read não marca mensagens de conversas alheias', async () => {
  calls.length = 0;
  await handlers['messages:read']({ chatId: 'alheio' }); await tick();
  assert.ok(!calls.includes('UPDATEMANY'));
  await handlers['messages:read']({ chatId: 'c1' }); await tick();
  assert.ok(calls.includes('UPDATEMANY'));
});
test('typing só é emitido por quem entrou na sala', () => {
  calls.length = 0;
  handlers['typing:start']({ chatId: 'c1' });
  assert.ok(!calls.includes('BROADCAST:typing:start'));
  socket.join('chat:c1');
  handlers['typing:start']({ chatId: 'c1' });
  assert.ok(calls.includes('BROADCAST:typing:start'));
});
test('mensagem acima do limite é recusada', async () => {
  calls.length = 0;
  await handlers['message:send']({ chatId: 'c1', text: 'x'.repeat(5000) }); await tick();
  assert.ok(calls.includes('EMIT:error'));
});
