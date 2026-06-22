'use strict';

require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');

console.log("1");
const app = require('./app');

console.log("2");
const logger = require('./utils/logger');

console.log("3");
const { setupSocket } = require('./sockets/chatSocket');

console.log("4");
const notifSvc = require('./services/notificationService');

console.log("5");
const auditMw = require('./middleware/audit');

console.log("6");

const PORT = Number(process.env.PORT) || 3001;
const prisma = new PrismaClient();

// ─── Fail fast on missing critical configuration ──────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  logger.error(`❌ Variáveis de ambiente obrigatórias em falta: ${missingEnv.join(', ')}`);
  logger.error('Configure o ficheiro .env a partir de .env.example antes de arrancar o servidor.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  logger.warn('⚠ FRONTEND_URL não definida em produção — CORS e cookies de sessão podem falhar para o frontend real.');
}
if (
  process.env.NODE_ENV === 'production' &&
  (process.env.JWT_ACCESS_SECRET.length < 32 || process.env.JWT_REFRESH_SECRET.length < 32)
) {
  logger.warn('⚠ JWT_ACCESS_SECRET/JWT_REFRESH_SECRET parecem demasiado curtos (<32 chars) para produção.');
}

const server = http.createServer(app);

// ─── Socket.IO Setup ──────────────────────────────────────────────
const socketAllowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const getSocketOrigin = () => {
  if (socketAllowedOrigins.length > 0) {
    return socketAllowedOrigins;
  }
  if (process.env.NODE_ENV === 'production') {
    return "*"; 
  }
  return true;
};

const io = new Server(server, {
  cors: {
    origin: getSocketOrigin(),
    credentials: socketAllowedOrigins.length > 0 ? true : false,
    methods: ["GET", "POST"]
  }
});

setupSocket(io);
app.set('io', io); // Allow controllers to access io via req.app.get('io')

// ─── Initialize services that need Prisma/Socket.IO ──────────────
notifSvc.init(prisma, io);
auditMw.init(prisma);

// ─── Database connection check ────────────────────────────────────
const startServer = async () => {
  try {
    await prisma.$connect();
    logger.info('✅ Conexão com a base de dados estabelecida.');

    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Bazares API a correr na porta ${PORT}`);
      logger.info(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔌 Socket.IO activo para chat em tempo real`);
    });
  } catch (err) {
    logger.error(`❌ Falha ao conectar à base de dados: ${err.message}`);
    logger.error('Verifique a variável DATABASE_URL no ficheiro .env');
    process.exit(1);
  }
};

// ─── Graceful Shutdown ─────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} recebido. Encerrando graciosamente...`);
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Servidor encerrado.');
    process.exit(0);
  });
  // Force exit after 10s if not closed
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

console.log("=== Vou iniciar o servidor ===");
startServer();
