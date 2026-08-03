'use strict';

// ─────────────────────────────────────────────────────────────────
// Preenche o campo `username` (alcunha para menções "@utilizador")
// em todas as contas criadas antes desta funcionalidade existir.
// Idempotente: só mexe em quem ainda tem username=null.
//
// Uso:  node scripts/backfill-usernames.js
// ─────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const { uniqueUsername } = require('../src/utils/slugify');

const prisma = new PrismaClient();

async function run() {
  const users = await prisma.user.findMany({
    where: { username: null },
    select: { id: true, name: true }
  });

  console.log(`[backfill-usernames] ${users.length} utilizador(es) sem username.`);

  let done = 0;
  for (const u of users) {
    const username = await uniqueUsername(u.name || 'utilizador', async (candidate) => {
      const found = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
      return !!found;
    });
    await prisma.user.update({ where: { id: u.id }, data: { username } });
    done++;
    if (done % 50 === 0) console.log(`  … ${done}/${users.length}`);
  }

  console.log(`[backfill-usernames] concluído: ${done} conta(s) actualizada(s).`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error('[backfill-usernames] falhou:', err);
  await prisma.$disconnect();
  process.exit(1);
});
