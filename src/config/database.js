'use strict';

const { PrismaClient } = require('@prisma/client');

// Singleton — uma única conexão partilhada por todos os controllers.
// Instanciar PrismaClient em cada módulo cria um connection pool por
// ficheiro, o que esgota as ligações disponíveis no PostgreSQL rapidamente.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['warn', 'error']
    : ['error']
});

module.exports = prisma;
