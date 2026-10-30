'use strict';

const { PrismaClient } = require('@prisma/client');
const { ledgerGuardMiddleware, assertMutationAllowed } = require('../utils/ledgerGuard');

// Singleton — uma única conexão partilhada por todos os controllers.
// Instanciar PrismaClient em cada módulo cria um connection pool por
// ficheiro, o que esgota as ligações disponíveis no PostgreSQL rapidamente.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['warn', 'error']
    : ['error']
});

// Ledger append-only: nenhum código pode editar/apagar movimentos da wallet.
// Prisma 5: middleware `$use`. Prisma 6+ REMOVEU `$use` — antes, com a actualização, esta protecção
// desligava-se em silêncio (o `if` simplesmente não corria). Agora cai para uma extensão de cliente
// (`$extends`), que funciona em 5, 6 e 7 e também dentro de `$transaction`.
let client = prisma;
if (typeof prisma.$use === 'function') {
  prisma.$use(ledgerGuardMiddleware);
} else if (typeof prisma.$extends === 'function') {
  client = prisma.$extends({
    name: 'ledger-guard',
    query: {
      walletTransaction: {
        async $allOperations({ operation, args, query }) {
          assertMutationAllowed({ model: 'WalletTransaction', action: operation });
          return query(args);
        }
      }
    }
  });
} else {
  // Nunca falhar em silêncio: se nenhuma das duas APIs existir, o arranque avisa alto.
  console.error('[ledger-guard] ATENÇÃO: este Prisma não tem $use nem $extends — o ledger NÃO está protegido contra edições.');
}

module.exports = client;
