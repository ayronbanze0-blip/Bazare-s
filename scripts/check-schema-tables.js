#!/usr/bin/env node
/**
 * Confere se cada model do prisma/schema.prisma tem a tabela correspondente na base de dados.
 * Apanha o caso "migration marcada como aplicada mas a tabela nunca foi criada".
 *
 *   node scripts/check-schema-tables.js --list     -> só lista as tabelas esperadas (sem BD)
 *   DATABASE_URL=... node scripts/check-schema-tables.js [--strict]
 *
 * Usa o `psql` (já instalado nos runners do GitHub). Sem --strict nunca falha: emite avisos
 * ::warning:: do GitHub Actions. Com --strict sai com código 1 se faltar alguma tabela.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const tables = [];
const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
let m;
while ((m = re.exec(schema))) {
  const map = /@@map\("([^"]+)"\)/.exec(m[2]);
  tables.push(map ? map[1] : m[1]);
}

if (process.argv.includes('--list')) { console.log(tables.join('\n')); process.exit(0); }

const url = process.env.DATABASE_URL;
if (!url) { console.log('::notice::Sem DATABASE_URL — verificação de tabelas ignorada.'); process.exit(0); }

const missing = [];
for (const t of tables) {
  const r = spawnSync('psql', [url, '-Atc', `select to_regclass('public."${t}"') is not null`], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(`::warning::psql falhou (${(r.stderr || '').trim().slice(0, 120)})`); process.exit(0); }
  if (r.stdout.trim() !== 't') missing.push(t);
}
console.log(`Tabelas esperadas: ${tables.length} | em falta: ${missing.length}`);
if (missing.length) {
  console.log(`::warning::Tabelas do schema que NÃO existem na base: ${missing.join(', ')}`);
  console.log('Cria-as à mão no SQL Editor (as migrations recentes têm IF NOT EXISTS) ou mostra-me este log.');
  if (process.argv.includes('--strict')) process.exit(1);
}
