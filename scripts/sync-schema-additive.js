#!/usr/bin/env node
/**
 * Sincronização ADITIVA do schema: compara a base de dados REAL com prisma/schema.prisma e cria
 * o que falta (tabelas, enums, colunas novas, índices, chaves estrangeiras), ignorando o histórico
 * de _prisma_migrations. Corrige o caso "migration registada como aplicada mas a tabela não existe".
 *
 * NUNCA apaga nada: qualquer instrução com DROP, mudança de tipo de coluna, NOT NULL, rename, etc.
 * é IGNORADA e apenas listada no log. Cada instrução corre à parte (uma falha não trava as outras).
 * Tabelas novas ficam com ROW LEVEL SECURITY activo (convenção das migrations deste projecto).
 *
 *   node scripts/sync-schema-additive.js            -> aplica
 *   node scripts/sync-schema-additive.js --dry      -> só mostra o plano
 *   node scripts/sync-schema-additive.js --from-file diff.sql --dry   -> testes (sem BD)
 * Variáveis: DIRECT_URL (preferida) ou DATABASE_URL. SCHEMA_AUTOSYNC=false desliga.
 * Sai sempre com código 0 (nunca impede o arranque), excepto com --strict e falhas.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const STRICT = args.includes('--strict');
const fromFileIdx = args.indexOf('--from-file');
const root = path.join(__dirname, '..');

// ─── Classificação das instruções ────────────────────────────────────
// Divide o script do `prisma migrate diff` em blocos "-- Título\n<sql>".
const splitBlocks = (script) => {
  const blocks = [];
  let cur = null;
  for (const line of script.split('\n')) {
    const h = /^--\s+(\w+)\s*$/.exec(line);
    if (h) { cur = { kind: h[1], sql: '' }; blocks.push(cur); continue; }
    if (cur) cur.sql += line + '\n';
  }
  return blocks.map((b) => ({ ...b, sql: b.sql.trim() })).filter((b) => b.sql);
};

const SAFE_KINDS = new Set(['CreateEnum', 'CreateTable', 'CreateIndex', 'AddForeignKey']);

const classify = (b) => {
  // Destrutivo = DROP, TRUNCATE, DELETE FROM, RENAME, SET NOT NULL, mudança de tipo de coluna.
  // (`ON DELETE CASCADE` de uma FK e colunas chamadas "type" NÃO contam.)
  const destructive = /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bRENAME\b|\bSET\s+NOT\s+NULL\b|\bALTER\s+COLUMN\s+"[^"]+"\s+(SET\s+DATA\s+)?TYPE\b/i;
  if (b.kind !== 'CreateEnum' && destructive.test(b.sql)) return { ok: false, why: 'destrutivo/ambíguo' };
  if (SAFE_KINDS.has(b.kind)) return { ok: true };
  if (b.kind === 'AlterEnum' && /ADD\s+VALUE/i.test(b.sql)) return { ok: true };
  if (b.kind === 'AlterTable') {
    // Só aceitamos "ADD COLUMN" (várias cláusulas separadas por vírgula). Coluna NOT NULL sem
    // DEFAULT falharia em tabelas com dados — nesse caso fica para o Postgres recusar (log).
    const body = b.sql.replace(/^ALTER TABLE\s+"[^"]+"\s*/i, '').replace(/;\s*$/, '');
    const clauses = body.split(/,\s*(?=ADD\s+COLUMN)/i);
    if (clauses.length && clauses.every((c) => /^ADD\s+COLUMN\b/i.test(c.trim()))) return { ok: true };
    return { ok: false, why: 'AlterTable que não é só ADD COLUMN' };
  }
  return { ok: false, why: `tipo ${b.kind} não suportado` };
};

const plan = (script) => {
  const todo = []; const skipped = [];
  for (const b of splitBlocks(script)) {
    const c = classify(b);
    (c.ok ? todo : skipped).push({ ...b, why: c.why });
  }
  // CreateTable antes de CreateIndex/AddForeignKey; enums primeiro.
  const order = { CreateEnum: 0, AlterEnum: 1, CreateTable: 2, AlterTable: 3, CreateIndex: 4, AddForeignKey: 5 };
  todo.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return { todo, skipped };
};

module.exports = { splitBlocks, classify, plan };
if (require.main !== module) return;

// ─── Execução ────────────────────────────────────────────────────────
(async () => {
  if (process.env.SCHEMA_AUTOSYNC === 'false') { console.log('[sync] SCHEMA_AUTOSYNC=false — ignorado.'); return; }

  let script;
  if (fromFileIdx >= 0) {
    script = fs.readFileSync(args[fromFileIdx + 1], 'utf8');
  } else {
    const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
    if (!url) { console.log('[sync] Sem DIRECT_URL/DATABASE_URL — ignorado.'); return; }
    const r = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
    if (r.status !== 0) { console.log(`[sync] Não consegui comparar com a base (${(r.stderr || '').trim().split('\n').pop()}).`); if (STRICT) process.exit(1); return; }
    script = r.stdout;
  }

  const { todo, skipped } = plan(script);
  console.log(`[sync] A aplicar ${todo.length} instrução(ões) aditiva(s); ${skipped.length} ignorada(s).`);
  skipped.forEach((s) => console.log(`[sync]   ignorada (${s.why}): ${s.sql.split('\n')[0].slice(0, 110)}`));
  if (!todo.length) { console.log('[sync] Base de dados já tem tudo o que o schema pede.'); return; }

  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  let failed = 0;
  for (const b of todo) {
    const first = b.sql.split('\n')[0].slice(0, 110);
    if (DRY) { console.log(`[sync]   (dry) ${b.kind}: ${first}`); continue; }
    const extra = b.kind === 'CreateTable'
      ? `\n${[...b.sql.matchAll(/CREATE TABLE\s+"([^"]+)"/gi)].map((m) => `ALTER TABLE "${m[1]}" ENABLE ROW LEVEL SECURITY;`).join('\n')}`
      : '';
    const r = spawnSync('npx', ['prisma', 'db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'],
      { cwd: root, input: b.sql + extra, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
    if (r.status === 0) console.log(`[sync]   ok ${b.kind}: ${first}`);
    else { failed++; console.log(`[sync]   FALHOU ${b.kind}: ${first} -> ${((r.stderr || r.stdout) || '').trim().split('\n').slice(-2).join(' | ')}`); }
  }
  console.log(DRY ? '[sync] (dry) nada foi executado.' : `[sync] Concluído: ${todo.length - failed} ok, ${failed} falhadas.`);
  if (STRICT && failed) process.exit(1);
})().catch((e) => { console.log(`[sync] erro inesperado (ignorado): ${e.message}`); });
