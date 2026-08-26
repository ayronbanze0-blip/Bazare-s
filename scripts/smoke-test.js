'use strict';

/**
 * SMOKE TEST PÓS-DEPLOY
 * ============================================================
 * Antes desta ronda não havia nenhuma validação automática depois de
 * um deploy — o `/api/health` existia, mas nada o chamava sozinho.
 *
 * Corre um punhado de pedidos reais (sem autenticação, só os que são
 * públicos) contra a API já em produção/staging, para confirmar que o
 * deploy subiu mesmo saudável antes de dares o release como concluído.
 *
 * Uso:
 *   BASE_URL=https://a-tua-api.up.railway.app node scripts/smoke-test.js
 *
 * Sai com código 0 se tudo passar, 1 caso contrário — dá para encadear
 * num passo de CI/CD depois do deploy, ou correr manualmente.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

const checks = [
  {
    name: 'Health check (API + BD)',
    path: '/api/health',
    expectStatus: 200,
    expectBody: (body) => body.success === true && body.db === 'ok',
  },
  {
    name: 'Listagem pública de produtos responde',
    path: '/api/products?limit=1',
    expectStatus: 200,
  },
  {
    name: 'Listagem pública de bazares responde',
    path: '/api/bazars?limit=1',
    expectStatus: 200,
  },
];

async function run() {
  console.log(`Smoke test contra ${BASE_URL}\n`);
  let failed = 0;

  for (const check of checks) {
    const url = `${BASE_URL}${check.path}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => null);

      const statusOk = res.status === check.expectStatus;
      const bodyOk = check.expectBody ? (body && check.expectBody(body)) : true;

      if (statusOk && bodyOk) {
        console.log(`✅ ${check.name}`);
      } else {
        failed++;
        console.log(`❌ ${check.name} — status ${res.status} (esperado ${check.expectStatus})`);
        if (body) console.log(`   corpo: ${JSON.stringify(body).slice(0, 200)}`);
      }
    } catch (err) {
      failed++;
      console.log(`❌ ${check.name} — ${err.message}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} passaram.`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
