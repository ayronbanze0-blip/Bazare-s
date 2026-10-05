'use strict';
// Teste rápido do envio de email (Resend).
// Uso:  RESEND_API_KEY=re_xxx node test-email.js o-teu-email@exemplo.com
// Sem domínio verificado, o destinatário TEM de ser o email da conta Resend.
require('dotenv').config();
const { sendEmail } = require('./src/services/emailService');

(async () => {
  const to = process.argv[2] || process.env.TEST_EMAIL_TO;
  if (!to) {
    console.error('Indique o destinatário: node test-email.js email@exemplo.com');
    process.exit(1);
  }
  const r = await sendEmail({
    to,
    subject: 'Teste de envio — Bazares',
    html: '<p>Se recebeu isto, o envio de email do Bazares está a funcionar.</p>'
  });
  console.log(r.ok ? `Enviado. ID: ${r.messageId}` : `Falhou: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
})();
