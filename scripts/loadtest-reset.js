'use strict';

/**
 * RESET DA BASE DE DADOS DE TESTE DE CARGA
 * ============================================================
 * Corre SÓ contra a base de dados apontada por DATABASE_URL neste
 * processo — que no workflow de teste de carga é a base Postgres
 * de teste dedicada (Render, ou Neon — nunca a Supabase de produção;
 * ver .github/workflows/load-test.yml).
 *
 * Apaga tudo o que os "vendedores" simulados criam (utilizadores,
 * bazares, publicações, reacções, comentários, tentativas de login),
 * para cada corrida do teste começar de uma BD limpa e os números
 * serem comparáveis entre corridas.
 *
 * Uso: DATABASE_URL=... node scripts/loadtest-reset.js
 */

const prisma = require('../src/config/database');

// Cascade a partir de User apaga a esmagadora maioria (Bazar,
// Announcement, FeedReaction, Comment, RefreshToken, etc. têm
// onDelete: Cascade a partir do dono). LoginAttempt/AuditLog não têm
// FK obrigatória a User, por isso vão à parte.
const TABLES_TO_TRUNCATE = ['User', 'LoginAttempt', 'AuditLog'];

// Domínios conhecidos de bases de dados de TESTE — nunca acrescentar
// aqui o domínio da Supabase de produção.
const KNOWN_TEST_DB_HOSTS = ['neon.tech', 'render.com'];

async function main() {
  const dbUrl = process.env.DATABASE_URL || '';
  const isKnownTestDb = KNOWN_TEST_DB_HOSTS.some((host) => dbUrl.includes(host));

  if (!isKnownTestDb && !process.env.LOADTEST_ALLOW_NON_NEON) {
    // Trava de segurança: este script APAGA dados. Só corre por omissão
    // contra uma DATABASE_URL cujo domínio esteja em KNOWN_TEST_DB_HOSTS
    // — nunca contra a Supabase de produção por engano. Define
    // LOADTEST_ALLOW_NON_NEON=1 se mudares de base de dados de teste
    // outra vez e isto for um falso negativo.
    console.error('❌ DATABASE_URL não parece ser uma base de dados de teste conhecida — a abortar por segurança.');
    console.error(`   (Domínios aceites: ${KNOWN_TEST_DB_HOSTS.join(', ')}. Isto existe para nunca truncar a base de dados de produção por engano.)`);
    process.exit(1);
  }

  for (const table of TABLES_TO_TRUNCATE) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
    console.log(`✓ ${table} limpa`);
  }

  console.log('✅ Base de dados de teste de carga pronta para uma nova corrida.');
}

main()
  .catch((err) => {
    console.error('❌ Falhou a limpar a base de dados de teste:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
