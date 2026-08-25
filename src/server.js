'use strict';

require('dotenv').config();

// ─── Sentry (TEM de ser o 1º require depois do dotenv — antes de
// './app' e de tudo o resto, para conseguir capturar erros de
// qualquer módulo carregado a seguir) ──────────────────────────────
const Sentry = require('./config/sentry');

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const logger = require('./utils/logger');
const { setupSocket } = require('./sockets/chatSocket');
const notifSvc = require('./services/notificationService');
const auditMw = require('./middleware/audit');

const PORT = Number(process.env.PORT) || 3001;
const prisma = require('./config/database');

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
// IMPORTANTE: uma falha de ligação à base de dados (ex.: Neon suspensa
// por limite de CU, Supabase ainda a acordar, blip de rede) já NÃO
// derruba o processo inteiro. Antes disto, um `process.exit(1)` aqui
// significava que o Render nunca sequer punha o servidor HTTP a
// escutar — o frontend via "sem ligação ao servidor" para TUDO,
// mesmo rotas que não precisam da DB, e não havia recuperação
// automática quando a DB voltasse (era preciso um redeploy manual).
// Agora: o servidor arranca sempre; as rotas que precisam da DB
// continuam a falhar normalmente (Prisma lança erro, errorHandler.js
// responde 500/503) enquanto ela estiver em baixo, e uma tentativa de
// reconexão em segundo plano (backoff crescente, teto de 30s) repõe a
// ligação sozinha assim que a DB voltar — sem intervenção manual.
const DB_RETRY_MAX_MS = 30000;
let dbConnected = false;

const tryConnect = async (attempt = 1) => {
  try {
    await prisma.$connect();
    dbConnected = true;
    logger.info('✅ Conexão com a base de dados estabelecida.');
  } catch (err) {
    dbConnected = false;
    const wait = Math.min(DB_RETRY_MAX_MS, 1000 * Math.pow(2, attempt - 1));
    logger.error(`❌ Falha ao conectar à base de dados (tentativa ${attempt}): ${err.message}`);
    if (attempt === 1) {
      logger.error('Verifique a variável DATABASE_URL — ou se a instância (Neon/Supabase) está activa/reactivada.');
    }
    setTimeout(() => tryConnect(attempt + 1), wait);
  }
};

const startServer = async () => {
  // Não bloqueia o arranque do HTTP à espera da DB — CORS, health
  // check, ficheiros estáticos e qualquer rota sem DB continuam a
  // responder mesmo com a base de dados em baixo.
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Bazares API a correr na porta ${PORT}`);
    logger.info(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🔌 Socket.IO activo para chat em tempo real`);
  });
  tryConnect();
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
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  Sentry.captureException(err);
  process.exit(1);
});

startServer();
