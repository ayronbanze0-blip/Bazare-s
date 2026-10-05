'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ─── Envio por API HTTPS (Resend; SendGrid como alternativa) ───────
// O Render (plano free) bloqueia SMTP de saída (465/587), por isso usamos
// APIs HTTPS em vez de SMTP/Nodemailer: a porta 443 nunca é bloqueada.
//
// Resend  (RESEND_API_KEY)   — prioritário se definido.
//   • Sem domínio verificado só envia DE onboarding@resend.dev e apenas PARA
//     o email da conta Resend (serve para testar). Para enviar a utilizadores
//     reais, verifique um domínio em resend.com/domains e defina
//     EMAIL_FROM_ADDRESS=no-reply@seudominio.com.
// SendGrid (SENDGRID_API_KEY) — usado só se RESEND_API_KEY não existir
//   (Single Sender Verification, sem domínio próprio).
const RESEND_API_URL = 'https://api.resend.com/emails';
const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const EMAIL_TIMEOUT_MS = 15000;

// ─── Banner animado da marca (GIF) ──────────────────────────────────
// Por omissão vai EMBUTIDO em cada email (anexo inline, cid:), por isso
// aparece sem depender de nenhum servidor. Se preferir hospedá-lo (menos
// peso por email), ponha o ficheiro no site e defina EMAIL_BANNER_URL=https://...
// Sem ficheiro nem URL, o email usa o cabeçalho de texto (sem imagens).
const BANNER_CID = 'bazares-banner';
const BANNER_FILE = path.join(__dirname, '..', 'assets', 'email', 'bazares-banner.gif');
let _bannerB64;
const getBannerB64 = () => {
  if (_bannerB64 === undefined) {
    try { _bannerB64 = fs.readFileSync(BANNER_FILE).toString('base64'); } catch { _bannerB64 = null; }
  }
  return _bannerB64;
};
const getBannerSrc = () =>
  process.env.EMAIL_BANNER_URL || (getBannerB64() ? `cid:${BANNER_CID}` : '');
// Anexo inline, só quando o HTML o referencia.
const getInlineAttachments = (html) =>
  String(html).includes(`src="cid:${BANNER_CID}"`) && getBannerB64()
    ? [{ filename: 'bazares-banner.gif', content: getBannerB64(), contentType: 'image/gif', contentId: BANNER_CID }]
    : [];

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'bazares03@gmail.com';
const SENDER_NAME = process.env.EMAIL_FROM_NAME || 'Bazares';

// Endereço remetente: o definido em EMAIL_FROM_ADDRESS; por omissão, o de
// teste do Resend (único permitido sem domínio) ou o sender do SendGrid.
const getSenderEmail = () =>
  process.env.EMAIL_FROM_ADDRESS ||
  (process.env.RESEND_API_KEY ? 'onboarding@resend.dev' : SUPPORT_EMAIL);

// Escapa texto vindo de utilizadores antes de o pôr no HTML do email.
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Layout de email (profissional, responsivo, compatível) ───────
// Construído com tabelas + estilos inline (Gmail, Outlook, Apple Mail e
// apps móveis ignoram CSS moderno). Um <style> mínimo adiciona o
// comportamento responsivo e o modo escuro onde é suportado.
// Sem emojis nem imagens externas: nada que possa aparecer partido.
const C = {
  brand: '#0A58F5', brandDark: '#0A2A8A', brandSoft: '#EAF2FF', brandLine: '#C7DBFF',
  mint: '#00E060', mintSoft: '#DBFFE8', mintLine: '#7DFFAD', mintText: '#00873A', mintInk: '#00562A',
  red: '#BD0303', redSoft: '#FEF1F1',
  text: '#0B1B3A', body: '#364562', muted: '#667690', line: '#E3E8F0', page: '#FFFFFF'
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

// URL base da app (primeira origem de FRONTEND_URL) para os botões.
const getAppUrl = () =>
  String(process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
const appLink = (path) => {
  const base = getAppUrl();
  return base ? `${base}/${String(path).replace(/^\/+/, '')}` : '';
};

// 12500 -> "12\u00A0500 MT" (separador de milhares fixo, não depende do ICU do servidor).
const money = (v) => `${Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')} MT`;

// ── Blocos reutilizáveis (todos devolvem HTML; o texto dinâmico entra já escapado)
const para = (html) =>
  `<p class="txt" style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};">${html}</p>`;

const small = (html) =>
  `<p class="muted" style="margin:0 0 4px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${html}</p>`;

const codeBox = (code) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;border-collapse:separate;">
  <tr><td align="center" class="code-box" bgcolor="${C.mintSoft}" style="background:${C.mintSoft};border:1px solid ${C.mintLine};border-radius:12px;padding:20px 12px;">
    <div class="code-label" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.mintText};margin-bottom:8px;">O seu código</div>
    <div class="code" style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,'Courier New',monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:8px;color:${C.brandDark};padding-left:8px;">${esc(code)}</div>
  </td></tr>
</table>`;

const button = (label, url) => !url ? '' : `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-wrap" style="margin:8px 0 20px;">
  <tr><td align="center" bgcolor="${C.brand}" style="border-radius:10px;background:${C.brand};">
    <a href="${esc(url)}" target="_blank" class="btn" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px;">${esc(label)}</a>
  </td></tr>
</table>`;

// tipo: info | warning | danger | success
const notice = (type, html) => {
  const t = {
    info:    { bg: '#F6F8FC', bar: C.muted, fg: C.body },
    success: { bg: C.mintSoft, bar: C.mint, fg: C.mintInk },
    warning: { bg: C.brandSoft, bar: C.brand, fg: C.brandDark },
    danger:  { bg: C.redSoft, bar: C.red, fg: '#7F1D1D' }
  }[type] || {};
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate;">
  <tr><td bgcolor="${t.bg}" style="background:${t.bg};border-left:4px solid ${t.bar};border-radius:8px;padding:12px 16px;font-family:${FONT};font-size:14px;line-height:21px;color:${t.fg};">${html}</td></tr>
</table>`;
};

// rows: [[rótulo, valorHTML], ...]
const details = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="details" style="margin:0 0 20px;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;border-spacing:0;">
${rows.map(([k, v], i) => `  <tr>
    <td class="muted" valign="top" width="38%" style="padding:12px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${k}</td>
    <td class="txt dv" valign="top" style="padding:12px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${C.text};">${v}</td>
  </tr>`).join('\n')}
</table>`;

// Lista de produtos com miniatura, quantidade, preço e total.
const itemsList = (items = [], total) => {
  const rows = items.map((i, idx) => {
    const img = /^https:\/\//.test(String(i.imageUrl || ''))
      ? `<img src="${esc(i.imageUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid ${C.line};">`
      : `<div style="width:56px;height:56px;line-height:56px;text-align:center;border-radius:10px;background:${C.mintSoft};color:${C.mintText};font-family:${FONT};font-size:20px;font-weight:800;">${esc(String(i.name || '?').charAt(0).toUpperCase())}</div>`;
    const qty = Number(i.qty) || 1;
    return `  <tr>
    <td width="56" valign="top" style="padding:12px 0 12px 16px;${idx ? `border-top:1px solid ${C.line};` : ''}">${img}</td>
    <td valign="top" class="txt" style="padding:12px 12px;${idx ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${C.text};">${esc(i.name)}<div class="muted" style="font-size:12px;line-height:18px;font-weight:400;color:${C.muted};">Qtd. ${qty}${i.price != null ? ` &times; ${money(i.price)}` : ''}</div></td>
    <td valign="top" align="right" class="txt" style="padding:12px 16px 12px 0;${idx ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${C.text};white-space:nowrap;">${i.price != null ? money(i.price * qty) : ''}</td>
  </tr>`;
  }).join('\n');
  const foot = total == null ? '' : `  <tr>
    <td colspan="2" bgcolor="#F6F9FF" class="foot-cell" style="padding:14px 12px 14px 16px;background:#F6F9FF;border-top:1px solid ${C.line};border-radius:0 0 0 12px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.muted};">Total</td>
    <td align="right" bgcolor="#F6F9FF" class="foot-cell" style="padding:14px 16px 14px 0;background:#F6F9FF;border-top:1px solid ${C.line};border-radius:0 0 12px 0;font-family:${FONT};font-size:17px;font-weight:800;color:${C.brandDark};white-space:nowrap;">${money(total)}</td>
  </tr>`;
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="items" style="margin:0 0 20px;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;border-spacing:0;">
${rows}
${foot}
</table>`;
};

// Passos numerados (boas-vindas).
const steps = (items) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px;">
${items.map(([t, d], i) => `  <tr>
    <td width="46" valign="top" style="padding:0 0 16px;"><div style="width:32px;height:32px;line-height:32px;text-align:center;border-radius:16px;background:${C.mintSoft};color:${C.mintText};font-family:${FONT};font-size:14px;font-weight:800;">${i + 1}</div></td>
    <td valign="top" style="padding:2px 0 16px;font-family:${FONT};"><div class="txt" style="font-size:15px;line-height:22px;font-weight:700;color:${C.text};">${t}</div><div class="muted" style="font-size:13px;line-height:20px;color:${C.muted};">${d}</div></td>
  </tr>`).join('\n')}
</table>`;

// Barra de progresso da encomenda (4 passos).
const TRACK_STEPS = [['ACEITE', 'Aceite'], ['EM_PREPARACAO', 'Preparação'], ['EM_ENTREGA', 'Em entrega'], ['ENTREGUE', 'Entregue']];
const tracker = (status) => {
  const idx = TRACK_STEPS.findIndex(([k]) => k === status);
  if (idx < 0 && status !== 'PENDENTE') return '';
  const cells = TRACK_STEPS.map(([, label], i) => {
    const done = i <= idx;
    return `<td width="25%" valign="top" style="padding:0 3px;">
      <div style="height:6px;line-height:6px;font-size:0;border-radius:3px;background:${done ? C.mint : C.line};">&nbsp;</div>
      <div class="${done ? 'txt' : 'muted'}" style="margin-top:8px;font-family:${FONT};font-size:11px;line-height:14px;font-weight:${done ? 700 : 400};color:${done ? C.brandDark : C.muted};text-align:center;">${label}</div>
    </td>`;
  }).join('');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px -3px 22px;width:calc(100% + 6px);"><tr>${cells}</tr></table>`;
};


/**
 * Estrutura completa do email.
 * @param {{ preheader?: string, eyebrow?: string, title: string, content: string }} o
 */
const layout = ({ preheader = '', eyebrow = '', title, content }) => {
  const bannerSrc = getBannerSrc();
  return `<!DOCTYPE html>
<html lang="pt" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table{border-collapse:collapse;}
  img{border:0;outline:none;text-decoration:none;}
  a{color:${C.brand};}
  @media only screen and (max-width:600px){
    .outer{padding:0!important;}
    .container{width:100%!important;border-radius:0!important;border:0!important;}
    .px{padding-left:20px!important;padding-right:20px!important;}
    .title{font-size:22px!important;line-height:28px!important;}
    .code{font-size:28px!important;letter-spacing:6px!important;}
    .btn-wrap{width:100%!important;}
    .btn{display:block!important;padding:15px 20px!important;}
    .details td{display:block!important;width:auto!important;}
    .details td.dv{border-top:0!important;padding-top:2px!important;}
    .details td.muted{padding-bottom:0!important;}
  }
  @media (prefers-color-scheme:dark){
    body,.page{background:#0B0D10!important;}
    .container,.card{background:#14171B!important;}
    .title,.txt{color:#EAF1F6!important;}
    .muted{color:#9DACBE!important;}
    .footer-cell,.hdr{background:#14171B!important;}
    .footer-cell{border-color:#2A2F36!important;}
    .code-box{background:#0E2A19!important;border-color:#1D5A33!important;}
    a{color:#7FA8FF!important;}
    .code{color:#66FF94!important;}
    .code-label{color:#66FF94!important;}
    .details,.items{border-color:#2A2F36!important;}
    .foot-cell{background:#1B1F24!important;border-color:#2A2F36!important;}
    .items td{border-color:#2A2F36!important;}
    .details td{border-color:#2A2F36!important;}
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${C.page};">
<!--PRE--><div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${esc(preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div><!--/PRE-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" class="outer" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid ${C.line};border-radius:16px;overflow:hidden;">

    <!-- Cabeçalho -->
    ${bannerSrc
      ? `<tr><td class="hdr-img" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:0;font-size:0;line-height:0;"><img src="${esc(bannerSrc)}" width="598" alt="Bazares — Marketplace moçambicano" style="display:block;width:100%;max-width:598px;height:auto;border:0;"></td></tr>`
      : `<tr><td align="left" class="px hdr" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:28px 32px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" width="40" height="40" align="center" bgcolor="${C.brand}" style="width:40px;height:40px;background:${C.brand};border-radius:11px;font-family:${FONT};font-size:22px;line-height:40px;font-weight:800;color:#FFFFFF;">B</td>
        <td valign="middle" class="title" style="padding-left:12px;font-family:${FONT};font-size:21px;line-height:26px;font-weight:800;letter-spacing:3px;color:${C.brandDark};">BAZARES</td>
      </tr></table>
    </td></tr>`}
    <tr><td style="font-size:0;line-height:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="72%" height="4" bgcolor="${C.brand}" style="background:${C.brand};font-size:0;line-height:0;">&nbsp;</td>
      <td width="28%" height="4" bgcolor="${C.mint}" style="background:${C.mint};font-size:0;line-height:0;">&nbsp;</td>
    </tr></table></td></tr>

    <!-- Conteúdo -->
    <tr><td class="px card" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:36px 32px 12px;">
      ${eyebrow ? `<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.brand};margin-bottom:10px;">${esc(eyebrow)}</div>` : ''}
      <h1 class="title" style="margin:0 0 16px;font-family:${FONT};font-size:26px;line-height:32px;font-weight:800;color:${C.text};">${title}</h1>
      ${content}
    </td></tr>

    <!-- Rodapé -->
    <tr><td class="px footer-cell" bgcolor="#FFFFFF" style="background:#FFFFFF;border-top:1px solid ${C.line};padding:22px 32px;">
      <p class="muted" style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
        Precisa de ajuda? Fale connosco: <a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:${C.brand};font-weight:600;text-decoration:none;">${esc(SUPPORT_EMAIL)}</a> &nbsp;|&nbsp; +258 84 676 1897
      </p>
      <p class="muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
        &copy; ${new Date().getFullYear()} Bazares &middot; Moçambique. Recebeu este email porque tem uma conta no Bazares.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
};

// Versão em texto simples (melhora a entrega e serve de alternativa ao HTML).
const htmlToText = (html) =>
  String(html)
    .replace(/<!--PRE-->[\s\S]*?<!--\/PRE-->/g, '')
    .replace(/<head>[\s\S]*?<\/head>/i, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => {
      const label = t.replace(/<[^>]+>/g, '').trim();
      return h.startsWith('mailto:') ? label : `${label} (${h})`;
    })
    .replace(/<\/(p|div|h1|h2|tr|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#8199;|&zwnj;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&times;/g, 'x').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&copy;/g, '(c)').replace(/&middot;/g, '-')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim();

// ─── Email Sender ────────────────────────────────────────────────
const sendViaResend = async ({ to, subject, html }) => {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${SENDER_NAME} <${getSenderEmail()}>`,
      to: [to],
      reply_to: SUPPORT_EMAIL,
      subject,
      html,
      text: htmlToText(html),
      attachments: getInlineAttachments(html).map(a => ({ filename: a.filename, content: a.content, content_type: a.contentType, content_id: a.contentId }))
    }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Resend respondeu ${res.status}`);
  }
  return data.id || null;
};

const sendViaSendGrid = async ({ to, subject, html }) => {
  const res = await fetch(SENDGRID_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: getSenderEmail(), name: SENDER_NAME },
      subject,
      content: [{ type: 'text/plain', value: htmlToText(html) }, { type: 'text/html', value: html }],
      attachments: getInlineAttachments(html).map(a => ({ content: a.content, type: a.contentType, filename: a.filename, disposition: 'inline', content_id: a.contentId }))
    }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
  });

  // Sucesso do SendGrid é 202 com corpo vazio — não dá para fazer res.json()
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.errors?.map(e => e.message).join('; ') || `SendGrid respondeu ${res.status}`);
  }
  return res.headers.get('x-message-id');
};

const sendEmail = async ({ to, subject, html }) => {
  const useResend = !!process.env.RESEND_API_KEY;
  if (!useResend && !process.env.SENDGRID_API_KEY) {
    logger.warn(`[Email] Sem RESEND_API_KEY (nem SENDGRID_API_KEY) — email para ${to} NÃO foi enviado.`);
    return { ok: false, error: 'RESEND_API_KEY não configurada' };
  }

  try {
    logger.info(`[Email] A enviar para ${to} via ${useResend ? 'Resend' : 'SendGrid'}...`);
    const messageId = useResend
      ? await sendViaResend({ to, subject, html })
      : await sendViaSendGrid({ to, subject, html });
    logger.info(`[Email] Sucesso! ID: ${messageId}`);
    return { ok: true, messageId };
  } catch (err) {
    logger.error(`[Email] Falhou (${to}): ${err.message}`);
    return { ok: false, error: err.message };
  }
};

// ─── Email Templates ─────────────────────────────────────────────

const ORDER_STATUS = {
  PENDENTE:      { label: 'Pendente',       type: 'info',    msg: 'A sua encomenda foi recebida e aguarda confirmação do vendedor.' },
  ACEITE:        { label: 'Aceite',         type: 'success', msg: 'O vendedor aceitou a sua encomenda.' },
  EM_PREPARACAO: { label: 'Em preparação',  type: 'info',    msg: 'O vendedor está a preparar a sua encomenda.' },
  EM_ENTREGA:    { label: 'Em entrega',     type: 'info',    msg: 'A sua encomenda saiu para entrega. Confirme a recepção quando a receber.' },
  ENTREGUE:      { label: 'Entregue',       type: 'success', msg: 'A sua encomenda foi entregue. Obrigado por comprar no Bazares!' },
  CANCELADA:     { label: 'Cancelada',      type: 'danger',  msg: 'Esta encomenda foi cancelada.' }
};

const shortRef = (id) => String(id || '').slice(-8).toUpperCase();

const sendWelcomeEmail = (to, name, role) => {
  const first = esc(String(name || '').trim().split(/\s+/)[0] || 'bem-vindo');
  const isSeller = role === 'SELLER' || role === 'REVENDEDOR';
  const list = isSeller
    ? [
        ['Complete o perfil da sua loja', 'Foto, localização e contactos ajudam os clientes a confiar em si.'],
        ['Publique o seu primeiro produto', 'Fotografe, defina o preço e publique em poucos toques.'],
        ['Acompanhe as vendas', 'Receba as encomendas e veja os pagamentos no seu painel.']
      ]
    : [
        ['Complete o seu perfil', 'Adicione a sua foto e os dados de entrega para comprar mais depressa.'],
        ['Explore produtos e bazares', 'Descubra lojas perto de si e siga as suas favoritas.'],
        ['Compre com segurança', 'Pague por M-Pesa ou e-Mola e acompanhe a encomenda até à entrega.']
      ];
  return sendEmail({
    to,
    subject: 'Bem-vindo ao Bazares',
    html: layout({
      preheader: 'A sua conta está pronta. Veja como começar em 3 passos.',
      eyebrow: 'Conta criada',
      title: `Bem-vindo ao Bazares, ${first}`,
      content:
        para('A sua conta está pronta. O Bazares junta compras, lojas e comunidade num só lugar, feito para Moçambique.') +
        notice('success', 'Já pode iniciar sessão com o seu email e a sua palavra-passe.') +
        para('<strong>Comece em 3 passos:</strong>') +
        steps(list) +
        button('Abrir o Bazares', appLink('home.html')) +
        small('Se não criou esta conta, responda a este email e ajudamos a resolver.')
    })
  });
};

const sendVerificationEmail = (to, name, code) =>
  sendEmail({
    to,
    subject: 'O seu código de verificação — Bazares',
    html: layout({
      preheader: 'Use este código para verificar o seu email. Expira em 15 minutos.',
      eyebrow: 'Verificação de email',
      title: `Olá, ${esc(name)}`,
      content:
        para('Obrigado por se juntar ao <strong>Bazares</strong>. Introduza o código abaixo na aplicação para verificar o seu endereço de email.') +
        codeBox(code) +
        notice('warning', 'Este código expira em <strong>15 minutos</strong>. Não o partilhe com ninguém.') +
        small('Se não criou esta conta, pode ignorar este email.')
    })
  });

const sendPasswordResetEmail = (to, name, code) =>
  sendEmail({
    to,
    subject: 'Redefinir a palavra-passe — Bazares',
    html: layout({
      preheader: 'Recebemos um pedido para redefinir a sua palavra-passe.',
      eyebrow: 'Segurança da conta',
      title: 'Redefinir a palavra-passe',
      content:
        para(`Olá <strong>${esc(name)}</strong>, recebemos um pedido para redefinir a palavra-passe da sua conta. Introduza o código abaixo na aplicação:`) +
        codeBox(code) +
        notice('warning', 'Este código expira em <strong>15 minutos</strong>. A equipa do Bazares nunca lhe pedirá este código.') +
        notice('info', 'Se não fez este pedido, a sua conta continua segura e pode ignorar este email.')
    })
  });

const sendOrderNotificationEmail = (to, sellerName, order) => {
  const items = Array.isArray(order.items) ? order.items : [];
  return sendEmail({
    to,
    subject: `Nova encomenda #${shortRef(order.id)} — Bazares`,
    html: layout({
      preheader: `${order.buyerName || 'Um cliente'} fez uma encomenda de ${money(order.total)}.`,
      eyebrow: 'Nova encomenda',
      title: 'Recebeu uma nova encomenda',
      content:
        para(`Olá <strong>${esc(sellerName)}</strong>, um cliente acabou de fazer uma encomenda na sua loja. Aceite ou recuse o quanto antes.`) +
        itemsList(items, order.total) +
        details([
          ['Referência', `#${esc(shortRef(order.id))}`],
          ['Cliente', esc(order.buyerName)],
          ['Contacto', esc(order.buyerPhone)],
          ...(order.address ? [['Entrega', esc(order.address)]] : [])
        ]) +
        button('Ver encomenda', appLink(`order-detail.html?id=${encodeURIComponent(order.id)}`)) +
        small('Pode gerir todas as encomendas no seu painel de vendedor.')
    })
  });
};

const sendOrderStatusEmail = (to, buyerName, order, status) => {
  const st = ORDER_STATUS[status] || { label: String(status || '—'), type: 'info', msg: 'O estado da sua encomenda foi atualizado.' };
  return sendEmail({
    to,
    subject: `Encomenda #${shortRef(order.id)}: ${st.label} — Bazares`,
    html: layout({
      preheader: st.msg,
      eyebrow: 'Atualização da encomenda',
      title: `Encomenda ${esc(st.label.toLowerCase())}`,
      content:
        para(`Olá <strong>${esc(buyerName)}</strong>,`) +
        notice(st.type, esc(st.msg)) +
        tracker(status) +
        (Array.isArray(order.items) && order.items.length ? itemsList(order.items, order.total) : '') +
        details([
          ['Referência', `#${esc(shortRef(order.id))}`],
          ['Estado', esc(st.label)]
        ]) +
        button('Acompanhar encomenda', appLink(`order-detail.html?id=${encodeURIComponent(order.id)}`))
    })
  });
};

const sendAccountSuspendedEmail = (to, name, reason) =>
  sendEmail({
    to,
    subject: 'A sua conta foi suspensa — Bazares',
    html: layout({
      preheader: 'A sua conta no Bazares foi temporariamente suspensa.',
      eyebrow: 'Aviso da conta',
      title: 'A sua conta foi suspensa',
      content:
        para(`Olá <strong>${esc(name)}</strong>, a sua conta no Bazares foi temporariamente suspensa.`) +
        (reason ? notice('danger', `<strong>Motivo:</strong> ${esc(reason)}`) : '') +
        para('Se acredita que foi um engano ou quer contestar esta decisão, responda a este email ou contacte o suporte:') +
        button('Contactar o suporte', `mailto:${SUPPORT_EMAIL}`)
    })
  });

const sendFeeAlertEmail = (to, sellerName, amount) =>
  sendEmail({
    to,
    subject: 'Contribuição pendente — Bazares',
    html: layout({
      preheader: `A sua contribuição pendente é de ${money(amount)}.`,
      eyebrow: 'Contribuição à plataforma',
      title: 'Tem uma contribuição pendente',
      content:
        para(`Olá <strong>${esc(sellerName)}</strong>, a sua contribuição pendente à plataforma atingiu <strong>${money(amount)}</strong>.`) +
        notice('warning', 'Para manter todas as funcionalidades da sua loja, efetue o pagamento.') +
        details([
          ['Nome', 'José Jeque'],
          ['Número', '84 676 1897'],
          ['Método', 'M-Pesa'],
          ['Valor', money(amount)]
        ]) +
        button('Abrir a minha carteira', appLink('wallet.html')) +
        small(`Após o pagamento, envie o comprovativo para <a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:${C.brand};font-weight:600;">${esc(SUPPORT_EMAIL)}</a>.`)
    })
  });

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendOrderNotificationEmail,
  sendOrderStatusEmail,
  sendAccountSuspendedEmail,
  sendFeeAlertEmail
};


