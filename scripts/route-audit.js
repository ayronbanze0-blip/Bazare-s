'use strict';

/**
 * Auditoria ESTÁTICA de rotas (sem arrancar o servidor, sem dependências).
 * Lê src/routes/index.js (montagens) e cada ficheiro de rotas e devolve, por rota:
 *   METHOD | PATH completo | AUTH | ROLE | RATE LIMIT
 *
 * Usos:
 *   node scripts/route-audit.js            -> imprime a tabela em Markdown
 *   node scripts/route-audit.js --write    -> escreve docs/ROTAS.md
 *   require('./route-audit').auditRoutes() -> usado por tests/unit/route-audit.test.js
 *
 * AUTH: yes | optional | no        ROLE: ADMIN | SELLER/ADMIN | BUYER | REVENDEDOR/ADMIN | any
 * (OWNER CHECK não é detectável de forma fiável por análise estática — ver docs/ROTAS.md.)
 */

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const ROLE_MW = { isAdmin: 'ADMIN', isSeller: 'SELLER/ADMIN', isBuyer: 'BUYER', isRevendedor: 'REVENDEDOR/ADMIN' };

// Mounts em routes/index.js:  router.use('/prefix', require('./file'))
function readMounts() {
  const src = fs.readFileSync(path.join(ROUTES_DIR, 'index.js'), 'utf8');
  const mounts = [];
  // aceita middlewares entre o path e o require (ex.: requireFeature('ENABLE_AI'), require('./aiRoutes'))
  const re = /router\.use\(\s*'([^']+)'\s*,[^;]*?require\('\.\/([A-Za-z0-9_]+)'\)\s*\)/g;
  let m;
  while ((m = re.exec(src))) mounts.push({ prefix: m[1], file: `${m[2]}.js` });
  return mounts;
}

// Extrai o texto entre parênteses balanceados a partir de `start` (índice do "(").
function balanced(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(start + 1, i); }
  }
  return src.slice(start + 1);
}

function describeChain(text, inherited) {
  const auth = /\bauthenticate\b/.test(text) ? 'yes' : /\boptionalAuth\b/.test(text) ? 'optional' : inherited.auth;
  const roles = Object.keys(ROLE_MW).filter((k) => new RegExp(`\\b${k}\\b`).test(text)).map((k) => ROLE_MW[k]);
  const requireRole = /requireRole\(([^)]*)\)/.exec(text);
  if (requireRole) roles.push(requireRole[1].replace(/['"\s]/g, '').replace(/,/g, '/'));
  const limiters = [...new Set((text.match(/\b\w*Limiter\b/g) || []))];
  return {
    auth,
    role: roles.length ? roles.join('+') : inherited.role,
    limiters: [...new Set([...inherited.limiters, ...limiters])]
  };
}

function auditFile(file, prefix) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const routes = [];
  let inherited = { auth: 'no', role: 'any', limiters: [] };
  const re = /\brouter\.(get|post|put|patch|delete|use|all)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const method = m[1];
    const args = balanced(src, m.index + m[0].length - 1);
    if (method === 'use') {
      // router.use(mw...) sem path -> aplica-se a TODAS as rotas seguintes
      if (!/^\s*['"`]/.test(args)) inherited = describeChain(args, inherited);
      continue;
    }
    const pm = /^\s*(['"`])([^'"`]*)\1/.exec(args) || /^\s*(\/.*?\/[a-z]*)\s*,/.exec(args);
    const routePath = pm ? (pm[2] !== undefined ? pm[2] : pm[1]) : '(dinâmico)';
    const info = describeChain(args, inherited);
    routes.push({
      method: method.toUpperCase(),
      path: `/api${prefix}${routePath === '/' ? '' : routePath}`,
      auth: info.auth,
      role: info.role,
      limiters: info.limiters,
      file
    });
  }
  return routes;
}

function auditRoutes() {
  const all = [];
  for (const { prefix, file } of readMounts()) all.push(...auditFile(file, prefix));
  return all;
}

function toMarkdown(routes) {
  const lines = [
    '# Auditoria de rotas (gerado automaticamente)',
    '',
    'Gerado por `node scripts/route-audit.js --write`. **Não editar à mão.**',
    'OWNER CHECK não é detectável por análise estática — as verificações de propriedade estão nos controllers',
    '(ver testes em `tests/security/`).',
    '',
    '| METHOD | PATH | AUTH | ROLE | RATE LIMIT |',
    '|---|---|---|---|---|'
  ];
  for (const r of routes) lines.push(`| ${r.method} | \`${r.path}\` | ${r.auth} | ${r.role} | ${r.limiters.join(', ') || '—'} |`);
  lines.push('', `Total: ${routes.length} rotas.`);
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const md = toMarkdown(auditRoutes());
  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'ROTAS.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    console.log(`Escrito ${out}`);
  } else {
    process.stdout.write(md);
  }
}

module.exports = { auditRoutes, toMarkdown };
