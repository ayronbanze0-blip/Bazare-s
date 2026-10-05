'use strict';

/**
 * Verificação de integridade do código ANTES de arrancar (corre no build do Docker).
 *
 * Problema que resolve: ao subir ficheiros um a um para o GitHub, é fácil ficar com um ficheiro
 * desactualizado (ex.: rateLimiter.js sem `chatSendLimiter`). O servidor só rebentava no arranque com
 * "Route.post() requires a callback function but got undefined", sem dizer qual.
 *
 * Aqui, sem precisar de node_modules nem de base de dados, confirma-se que:
 *   1. todo o require('./x') / require('../x') aponta para um ficheiro que existe;
 *   2. todo o nome importado por destructuring de um módulo local existe nos exports desse módulo;
 *   3. todo o `alias.nome` usado a partir de um módulo local (ex.: ctrl.sendMessage) existe nos exports.
 *
 * Se algo falhar, o build falha com a lista exacta "ficheiro:linha → o que falta e onde".
 * No Render, um build que falha NÃO substitui a versão que está no ar.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts'];
const problems = [];
const exportsCache = new Map();

const walk = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

const resolveLocal = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
};

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// Lista de nomes exportados, ou null quando não dá para saber com certeza (então não validamos).
const exportedNames = (file) => {
  if (exportsCache.has(file)) return exportsCache.get(file);
  let result = null;
  if (file.endsWith('.js')) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const names = new Set();
    let known = true;
    const m = src.match(/module\.exports\s*=\s*\{/);
    if (m) {
      let i = m.index + m[0].length, depth = 1, start = i;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        i++;
      }
      const body = src.slice(start, i - 1);
      let d = 0, cur = '';
      const parts = [];
      for (const ch of body) {
        if ('{(['.includes(ch)) d++;
        if ('})]'.includes(ch)) d--;
        if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
      }
      parts.push(cur);
      for (const p of parts) {
        const t = p.trim();
        if (!t) continue;
        if (t.startsWith('...')) { known = false; continue; }
        const nm = t.match(/^(?:async\s+)?(?:get\s+|set\s+)?['"]?([A-Za-z_$][\w$]*)['"]?/);
        if (nm) names.add(nm[1]); else known = false;
      }
    } else if (/module\.exports\s*=/.test(src)) {
      known = false; // module.exports = função/identificador
    }
    for (const r of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(r[1]);
    if (!m && !names.size) known = false;
    result = known ? names : null;
  }
  exportsCache.set(file, result);
  return result;
};

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const rel = (f) => path.relative(ROOT, f);

for (const file of DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);

  // 1) requires locais
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    if (!resolveLocal(file, m[1])) {
      problems.push(`${rel(file)}:${lineOf(src, m.index)} → require('${m[1]}') aponta para um ficheiro que NÃO existe`);
    }
  }

  // 2) destructuring: const { a, b } = require('./x')
  for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = resolveLocal(file, m[2]);
    if (!target) continue;
    const names = exportedNames(target);
    if (!names) continue;
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0].trim();
      if (n && !n.startsWith('...') && !names.has(n)) {
        problems.push(`${rel(file)}:${lineOf(src, m.index)} → importa "${n}" de ${rel(target)}, mas esse ficheiro NÃO o exporta (versão desactualizada?)`);
      }
    }
  }

  // 3) alias.nome: const ctrl = require('../controllers/x')  →  ctrl.nome
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)\s*;/g)) {
    const target = resolveLocal(file, m[2]);
    if (!target) continue;
    const names = exportedNames(target);
    if (!names) continue;
    const alias = m[1];
    const seen = new Set();
    for (const u of src.matchAll(new RegExp(`(?<![\\w$.])${alias.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      const n = u[1];
      if (names.has(n) || seen.has(n)) continue;
      seen.add(n);
      problems.push(`${rel(file)}:${lineOf(src, u.index)} → usa ${alias}.${n}, mas ${rel(target)} NÃO exporta "${n}" (versão desactualizada?)`);
    }
  }
}

if (problems.length) {
  console.error('\n❌ INTEGRIDADE DO CÓDIGO FALHOU — ficheiros desencontrados (provavelmente um upload em falta/antigo):\n');
  for (const p of problems) console.error('  • ' + p);
  console.error(`\n${problems.length} problema(s). Corrija os ficheiros indicados e faça novo deploy.\n`);
  process.exit(1);
}
console.log('✅ Integridade do código OK — todos os imports e exports locais batem certo.');
