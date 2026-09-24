'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;
const { redact } = require('./redact');

// Redacta campos sensíveis (password, token, secret, code, msisdn…) em qualquer
// metadata passada ao logger — rede de segurança contra `logger.info('x', { body })`.
const RESERVED = new Set(['level', 'message', 'timestamp', 'stack', 'splat']);
const redactMeta = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (RESERVED.has(key)) continue;
    info[key] = redact({ [key]: info[key] })[key];
  }
  return info;
});

const isProduction = process.env.NODE_ENV === 'production';

// ─── Produção (Render) ─────────────────────────────────────────────
// O disco do container é EFÉMERO: qualquer coisa escrita em ficheiro
// desaparece no próximo deploy/restart e não é acessível sem shell.
// Por isso em produção só escrevemos para stdout/stderr em JSON — o
// Render captura isso automaticamente na tab "Logs" e torna-o
// pesquisável/filtrável (ex.: por level, por requestId).
//
// ─── Desenvolvimento (local) ──────────────────────────────────────
// Mantemos o formato colorido legível + ficheiros locais, como antes.
let transports;

if (isProduction) {
  transports = [
    new winston.transports.Console({
      format: combine(errors({ stack: true }), redactMeta(), timestamp(), json())
    })
  ];
} else {
  const logsDir = path.join(__dirname, '../../logs');
  let fileTransportsAvailable = false;
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    fileTransportsAvailable = true;
  } catch (e) {
    // fall back to console-only logging
  }

  const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${stack || message}${extra}`;
  });

  transports = [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), redactMeta(), logFormat)
    }),
    ...(fileTransportsAvailable ? [
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), redactMeta(), logFormat)
      }),
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), redactMeta(), logFormat)
      })
    ] : [])
  ];
}

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  transports
});

module.exports = logger;
