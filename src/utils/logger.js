'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

// ─── Produção (Railway) ───────────────────────────────────────────
// O disco do container é EFÉMERO: qualquer coisa escrita em ficheiro
// desaparece no próximo deploy/restart e não é acessível sem shell.
// Por isso em produção só escrevemos para stdout/stderr em JSON — o
// Railway captura isso automaticamente na tab "Logs" e torna-o
// pesquisável/filtrável (ex.: por level, por requestId).
//
// ─── Desenvolvimento (local) ──────────────────────────────────────
// Mantemos o formato colorido legível + ficheiros locais, como antes.
let transports;

if (isProduction) {
  transports = [
    new winston.transports.Console({
      format: combine(errors({ stack: true }), timestamp(), json())
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
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), logFormat)
    }),
    ...(fileTransportsAvailable ? [
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat)
      }),
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat)
      })
    ] : [])
  ];
}

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  transports
});

module.exports = logger;
