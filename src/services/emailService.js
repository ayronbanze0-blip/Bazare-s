'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// ─── Transporter ────────────────────────────────────────────────
let transporter;

const getTransporter = () => {
  if (transporter) return transporter;
  if (process.env.NODE_ENV === 'test' || !process.env.SMTP_USER) {
    // Use Ethereal (fake SMTP) in dev/test
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: { user: 'ethereal_user', pass: 'ethereal_pass' }
    });
    logger.warn('[Email] Using mock SMTP (Ethereal). Set SMTP_USER to use real email.');
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
  return transporter;
};

// ─── HTML Template Base ─────────────────────────────────────────
const baseTemplate = (content) => `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #F0F4F8; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg, #0B1F3A 0%, #1B3A6E 100%); padding: 32px; text-align: center; }
    .logo { font-size: 26px; font-weight: 900; color: #fff; letter-spacing: .5px; }
    .logo span { color: #C9A84C; }
    .body { padding: 32px; }
    h2 { color: #0B1F3A; font-size: 20px; margin-bottom: 12px; }
    p { color: #3D526A; font-size: 14px; line-height: 1.8; margin-bottom: 16px; }
    .code-box { background: #0B1F3A; color: #C9A84C; border-radius: 10px; padding: 18px; text-align: center; font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 24px 0; }
    .btn { display: inline-block; background: #0B1F3A; color: #fff; padding: 13px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin: 16px 0; }
    .footer { background: #F0F4F8; padding: 20px 32px; text-align: center; font-size: 12px; color: #A0B8CC; }
    .warning { background: #FFFBEB; border-left: 3px solid #D97706; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #92400E; margin-bottom: 16px; }
    .info { background: #EFF6FF; border-left: 3px solid #2563EB; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #1E3A8A; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">⬡ BAZ<span>ARES</span></div>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      © ${new Date().getFullYear()} Bazares · Marketplace Moçambicano<br>
      📧 bazares09@gmail.com · 📞 +258 84 676 1897
    </div>
  </div>
</body>
</html>`;

// ─── Email Sender ────────────────────────────────────────────────
const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || '"Bazares" <bazares09@gmail.com>',
      to,
      subject,
      html
    });
    logger.info(`[Email] Sent to ${to} — ${subject} (${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logger.error(`[Email] Failed to send to ${to}: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

// ─── Email Templates ─────────────────────────────────────────────

const sendVerificationEmail = (to, name, code) =>
  sendEmail({
    to,
    subject: '✅ Verificar o seu email — Bazares',
    html: baseTemplate(`
      <h2>Olá, ${name}!</h2>
      <p>Obrigado por se registar no <strong>Bazares</strong>. Use o código abaixo para verificar o seu endereço de email:</p>
      <div class="code-box">${code}</div>
      <div class="warning">⏰ Este código expira em <strong>15 minutos</strong>.</div>
      <p style="margin:0;font-size:13px;color:#6B7F96">Se não criou esta conta, ignore este email.</p>
    `)
  });

const sendPasswordResetEmail = (to, name, code) =>
  sendEmail({
    to,
    subject: '🔑 Redefinir palavra-passe — Bazares',
    html: baseTemplate(`
      <h2>Redefinição de palavra-passe</h2>
      <p>Olá <strong>${name}</strong>, recebemos um pedido para redefinir a palavra-passe da sua conta.</p>
      <p>Use o código abaixo:</p>
      <div class="code-box">${code}</div>
      <div class="warning">⏰ Este código expira em <strong>15 minutos</strong>.</div>
      <div class="info">🔒 Se não solicitou esta alteração, a sua conta está segura. Ignore este email.</div>
    `)
  });

const sendOrderNotificationEmail = (to, sellerName, order) =>
  sendEmail({
    to,
    subject: `🛒 Nova encomenda #${order.id} — Bazares`,
    html: baseTemplate(`
      <h2>Nova encomenda recebida!</h2>
      <p>Olá <strong>${sellerName}</strong>, recebeu uma nova encomenda:</p>
      <div class="info">
        <strong>Ref:</strong> ${order.id}<br>
        <strong>Produto:</strong> ${order.items.map(i => `${i.name} ×${i.qty}`).join(', ')}<br>
        <strong>Total:</strong> ${order.total.toLocaleString('pt-MZ')} MT<br>
        <strong>Cliente:</strong> ${order.buyerName}<br>
        <strong>Contacto:</strong> ${order.buyerPhone}
      </div>
      <p>Aceda ao seu painel para aceitar ou recusar a encomenda.</p>
    `)
  });

const sendOrderStatusEmail = (to, buyerName, order, status) =>
  sendEmail({
    to,
    subject: `📦 Estado da encomenda #${order.id} — Bazares`,
    html: baseTemplate(`
      <h2>Atualização da sua encomenda</h2>
      <p>Olá <strong>${buyerName}</strong>, a sua encomenda foi atualizada:</p>
      <div class="info">
        <strong>Ref:</strong> ${order.id}<br>
        <strong>Estado:</strong> <strong>${status}</strong>
      </div>
      <p>Aceda ao seu painel para acompanhar o progresso.</p>
    `)
  });

const sendAccountSuspendedEmail = (to, name, reason) =>
  sendEmail({
    to,
    subject: '⚠️ Conta suspensa — Bazares',
    html: baseTemplate(`
      <h2>A sua conta foi suspensa</h2>
      <p>Olá <strong>${name}</strong>, a sua conta no Bazares foi temporariamente suspensa.</p>
      ${reason ? `<div class="warning">Motivo: ${reason}</div>` : ''}
      <p>Para mais informações ou para contestar esta decisão, contacte o suporte:</p>
      <p>📧 bazares09@gmail.com<br>📞 +258 84 676 1897</p>
    `)
  });

const sendFeeAlertEmail = (to, sellerName, amount) =>
  sendEmail({
    to,
    subject: '⚠️ Contribuição pendente — Bazares',
    html: baseTemplate(`
      <h2>Contribuição à plataforma</h2>
      <p>Olá <strong>${sellerName}</strong>, a sua contribuição pendente atingiu <strong>${amount.toLocaleString('pt-MZ')} MT</strong>.</p>
      <div class="warning">Para manter todas as funcionalidades da sua loja, efectue o pagamento.</div>
      <p><strong>Dados de pagamento:</strong><br>
      Nome: José Jeque<br>
      Número: 84 676 1897<br>
      Método: M-Pesa</p>
      <p style="font-size:13px;color:#6B7F96">Após o pagamento, envie o comprovativo para bazares09@gmail.com</p>
    `)
  });

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendOrderNotificationEmail,
  sendOrderStatusEmail,
  sendAccountSuspendedEmail,
  sendFeeAlertEmail
};
