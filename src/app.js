'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();

// ─── Security Headers (Helmet + CSP) ─────────────────────────────
const frontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com', 'https://via.placeholder.com'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", ...frontendOrigins]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ─── CORS ─────────────────────────────────────────────────────────
// IMPORTANT: credentials:true cannot be combined with origin:'*' — browsers
// reject that combination outright, which would silently break the
// httpOnly refresh-token cookie (and therefore login) in production.
// We build an explicit allow-list instead, falling back to permissive
// CORS WITHOUT credentials only when no FRONTEND_URL is configured
// (e.g. quick local testing), so misconfiguration fails safely rather
// than fails open.
// ─── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // 1. Sempre permite requisições sem origem (curl, postman, robô do Railway)
    if (!origin) return callback(null, true);
    
    // 2. Se não houver FRONTEND_URL definida, abre para testes locais
    if (allowedOrigins.length === 0) return callback(null, true);
    
    // 3. Se a origem do navegador estiver na lista autorizada
    if (allowedOrigins.includes(origin)) return callback(null, true);
    
    // 4. Em desenvolvimento, não bloqueia o deploy por segurança
    if (process.env.NODE_ENV !== 'production') return callback(null, true);

    logger.warn(`[CORS] Blocked request from unauthorized origin: ${origin}`);
    return callback(new Error('Não autorizado pela política de CORS.'));
  },
  credentials: allowedOrigins.length > 0 ? true : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─── Body Parsing & Compression ──────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use(compression());

// ─── Request Logging ─────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ─── Trust proxy (for correct req.ip behind load balancers) ──────
app.set('trust proxy', 1);

// ─── Rate Limiting (general) ─────────────────────────────────────
app.use('/api', apiLimiter);

// ─── Routes ────────────────────────────────────────────────────────
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({
    name: 'Bazares API',
    version: '2.0.0',
    status: 'online',
    docs: '/api/health'
  });
});

// ─── 404 & Error Handling ─────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
