#!/usr/bin/env node
'use strict';
// Cruza as chamadas do frontend com as rotas reais do backend.
//   node scripts/audit-contrato.js /caminho/para/js/endpoints.js
// Lê a tabela endpoints.js do frontend (método + caminho) e as rotas em src/routes (o prefixo de cada
// ficheiro vem de src/routes/index.js). Sai com código 1 se faltar alguma rota — serve também em CI.
// Não cobre: caminhos montados com variáveis em runtime e `router.use` aninhados fora do index.js.
const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '..', 'src', 'routes');
const frontFile = process.argv[2];
if (!frontFile || !fs.existsSync(frontFile)) {
  console.error('Uso: node scripts/audit-contrato.js <caminho/para/endpoints.js>');
  process.exit(2);
}

// 1) prefixos: router.use('/auth', ... require('./authRoutes'))  (inclui '/' e prefixos com 2 níveis)
const index = fs.readFileSync(path.join(ROUTES, 'index.js'), 'utf8');
const mounts = {};
for (const m of index.matchAll(/router\.use\(\s*'([^']*)'[^;]*?require\('\.\/([A-Za-z0-9_]+)'\)/g)) mounts[m[2]] = m[1] === '/' ? '' : m[1];
mounts.index = ''; // rotas definidas directamente no index.js

// 2) rotas
const routes = [];
for (const [file, prefix] of Object.entries(mounts)) {
  const p = path.join(ROUTES, file + '.js');
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g)) {
    routes.push({ method: m[1].toUpperCase(), pattern: prefix + (m[3] === '/' ? '' : m[3]) || '/', file });
  }
  for (const m of src.matchAll(/router\.route\(\s*(['"`])([^'"`]*)\1\)((?:\s*\.(?:get|post|put|patch|delete)\([^)]*\))+)/g)) {
    for (const mm of m[3].matchAll(/\.(get|post|put|patch|delete)\(/g)) routes.push({ method: mm[1].toUpperCase(), pattern: prefix + m[2], file });
  }
}
const toRx = (pat) => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+') + '/?$');
routes.forEach((r) => { r.rx = toRx(r.pattern); });

// 3) endpoints do frontend: ["grupo","nome","GET","/caminho/:id",...]
const front = fs.readFileSync(frontFile, 'utf8');
const wanted = [...front.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"/g)]
  .map((m) => ({ group: m[1], name: m[2], method: m[3], path: m[4] }));

const missing = wanted.filter((w) => !routes.some((r) => r.method === w.method && r.rx.test(w.path.replace(/:[A-Za-z0-9_]+/g, 'x'))));
console.log(`Frontend: ${wanted.length} endpoints · Backend: ${routes.length} rotas`);
if (!missing.length) { console.log('OK — todas as chamadas do frontend têm rota no backend.'); process.exit(0); }
console.log(`FALTAM ${missing.length} no backend:`);
for (const w of missing) {
  const outro = routes.filter((r) => r.rx.test(w.path.replace(/:[A-Za-z0-9_]+/g, 'x'))).map((r) => r.method);
  console.log(`  ${w.method} ${w.path}  (${w.group}.${w.name})${outro.length ? '  [o caminho existe com ' + outro.join('/') + ']' : ''}`);
}
process.exit(1);
