'use strict';

const nodemailer = require('nodemailer');

// Transporter SMTP reutilizado (uma só ligação em pool, em vez de abrir uma por email).
// Só é usado como ÚLTIMO recurso em emailService (depois de Resend e SendGrid) e apenas em
// hospedagens que permitem SMTP de saída — o Render free bloqueia 465/587.
let transporter;

const isConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const getTransporter = () => {
  if (transporter) return transporter;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    pool: true,
    maxConnections: 3,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
  return transporter;
};

module.exports = { getTransporter, isConfigured };
