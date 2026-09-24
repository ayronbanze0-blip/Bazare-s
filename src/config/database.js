'use strict';

const { PrismaClient } = require('@prisma/client');
const { ledgerGuardMiddleware } = require('../utils/ledgerGuard');

// Singleton — uma única conexão partilhada por todos os controllers.
// Instanciar PrismaClient em cada módulo cria um connection pool por
// ficheiro, o que esgota as ligações disponíveis no PostgreSQL rapidamente.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['warn', 'error']
    : ['error']
});

// Ledger append-only: nenhum código pode editar/apagar movimentos da wallet.
if (typeof prisma.$use === 'function') prisma.$use(ledgerGuardMiddleware);

module.exports = prisma;
