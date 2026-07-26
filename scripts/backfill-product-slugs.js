'use strict';

// ─── Backfill de slugs de produto ───────────────────────────────────
// Corre uma única vez depois de aplicar a migração que adiciona o
// campo `slug` ao Product (ver prisma/schema.prisma). Preenche o slug
// de todos os produtos que ainda não têm um, sem tocar nos que já têm.
//
// Uso (Render → Shell, ou local): node scripts/backfill-product-slugs.js

require('dotenv').config();
const prisma = require('../src/config/database');
const { uniqueProductSlug } = require('../src/utils/slugify');

async function run() {
  const products = await prisma.product.findMany({
    where: { slug: null },
    select: { id: true, name: true, location: true }
  });

  console.log(`Encontrados ${products.length} produtos sem slug.`);

  let done = 0;
  for (const p of products) {
    const slug = await uniqueProductSlug(p, async (candidate) => {
      const existing = await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } });
      return !!existing;
    });
    await prisma.product.update({ where: { id: p.id }, data: { slug } });
    done++;
    if (done % 50 === 0) console.log(`  ...${done}/${products.length}`);
  }

  console.log(`Concluído: ${done} produtos actualizados.`);
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Erro no backfill de slugs:', err);
  process.exit(1);
});
