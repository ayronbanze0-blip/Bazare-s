// Limites de fotos: 20 por post / reel / publicação de comunidade, e o erro dos Reels com fotos.
// O multer não está instalado neste ambiente de testes, por isso há dois tipos de teste:
//  · de CONTRATO (lêem o código e garantem que as peças combinam — o bug dos Reels era exactamente
//    uma peça (uploadMedia: files:1) a contradizer outra (rota: images maxCount 10));
//  · de COMPORTAMENTO do errorHandler (mensagens que o utilizador vê).
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { MAX_IMAGES_PER_POST, MAX_STORY_SLIDES, MAX_STORIES_PER_BAZAR_LIST } = require(path.join(root, 'src/config/uploadLimits.js'));

test('constantes: 20 fotos por post/reel/slides e lista de histórias que cabe uma publicação cheia', () => {
  assert.strictEqual(MAX_IMAGES_PER_POST, 20);
  assert.strictEqual(MAX_STORY_SLIDES, 20);
  assert.ok(MAX_STORIES_PER_BAZAR_LIST >= MAX_STORY_SLIDES, 'a barra de histórias não pode cortar uma publicação de 20 slides');
});

test('contrato: o multer dos Reels aceita tantos ficheiros como a rota deixa enviar (bug "files: 1")', () => {
  const svc = read('src/services/uploadService.js');
  const m = svc.match(/const uploadMedia = multer\(\{[\s\S]*?limits:\s*\{[^}]*files:\s*([A-Za-z0-9_]+)/);
  assert.ok(m, 'não encontrei o limite files de uploadMedia');
  assert.notStrictEqual(m[1], '1', 'uploadMedia com files:1 rejeita qualquer Reel com 2+ fotos');
  const files = m[1] === 'MAX_IMAGES_PER_POST' ? MAX_IMAGES_PER_POST : Number(m[1]);
  const rotas = read('src/routes/bazarRoutes.js');
  const reels = [...rotas.matchAll(/uploadMedia\.fields\(\[([^\]]*)\]\)/g)].map((x) => x[1]);
  assert.ok(reels.length >= 3, 'esperava as rotas de histórias e reels');
  for (const campos of reels) {
    const maxImgs = (campos.match(/name:\s*'images',\s*maxCount:\s*([A-Za-z0-9_]+)/) || [])[1];
    if (!maxImgs) continue;
    const n = maxImgs === 'MAX_IMAGES_PER_POST' ? MAX_IMAGES_PER_POST : Number(maxImgs);
    assert.strictEqual(n, 20);
    assert.ok(files >= n, `uploadMedia aceita ${files} ficheiros mas a rota pede ${n}`);
  }
});

test('contrato: anúncios, reels e comunidades usam o mesmo limite (sem números soltos)', () => {
  const rotas = read('src/routes/bazarRoutes.js') + read('src/routes/communityRoutes.js');
  assert.ok(!/upload\.array\('images',\s*\d+\)/.test(rotas), 'ainda há um upload.array com número fixo');
  assert.ok(!/name:\s*'images',\s*maxCount:\s*\d+/.test(rotas), 'ainda há um maxCount de images com número fixo');
  const ctrl = read('src/controllers/reelController.js') + read('src/controllers/announcementController.js');
  assert.ok(!/(length|total)\s*>\s*(6|10)\b/.test(ctrl), 'ainda há um limite 6/10 nos controladores');
  assert.ok(!/Máximo de (6|10) fotos/.test(ctrl));
});

// ── errorHandler ────────────────────────────────────────────────
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (parent && /errorHandler\.js$/.test(parent.filename)) {
    if (req === '../config/sentry') return { captureException() {}, withScope() {} };
    if (req === '../utils/logger') return { error() {}, warn() {}, info() {} };
  }
  return orig.call(this, req, parent, ...r);
};
const { errorHandler } = require(path.join(root, 'src/middleware/errorHandler.js'));
Module._load = orig;

function chamar(err) {
  let out;
  const res = { headersSent: false, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  errorHandler(err, { id: 'r1', method: 'POST', originalUrl: '/api/bazars/x/reels', ip: '1', user: null }, res, () => {});
  return out;
}
const msg = (o) => (o.body.error && o.body.error.message) || o.body.message;
const cod = (o) => (o.body.error && o.body.error.code) || o.body.code;

test('errorHandler: fotos a mais dizem o limite (20) em vez de "campo inesperado"', () => {
  const a = chamar({ code: 'LIMIT_UNEXPECTED_FILE', field: 'images', message: 'Unexpected field' });
  assert.strictEqual(a.code, 400); assert.strictEqual(cod(a), 'TOO_MANY_FILES'); assert.ok(/20/.test(msg(a)), msg(a));
  const b = chamar({ code: 'LIMIT_FILE_COUNT', message: 'Too many files' });
  assert.strictEqual(b.code, 400); assert.ok(/20/.test(msg(b)), msg(b));
  const c = chamar({ code: 'LIMIT_UNEXPECTED_FILE', field: 'image', message: 'Unexpected field' });
  assert.strictEqual(cod(c), 'TOO_MANY_FILES');
  const d = chamar({ code: 'LIMIT_UNEXPECTED_FILE', field: 'outro', message: 'Unexpected field' });
  assert.strictEqual(cod(d), 'UNEXPECTED_FILE');
});
