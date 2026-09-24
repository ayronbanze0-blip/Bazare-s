'use strict';

/* ============================================================
   BAZARES — Sentry (rastreamento de erros)
   Este ficheiro TEM de ser importado (require) antes de qualquer
   outro módulo no server.js — o Sentry só consegue capturar erros
   de módulos que sejam carregados DEPOIS de Sentry.init() correr.

   Sem SENTRY_DSN definida no .env, isto fica inofensivo (Sentry.init
   nunca é chamado) — não precisas de nada configurado para correr
   localmente ou antes de teres conta no Sentry.

   A DSN não é secreta (é feita para ser pública — só permite ENVIAR
   eventos, nunca ler nada da tua conta), por isso está aqui como
   valor por omissão, para não teres de configurar nada no Render.
   Se quiseres trocar de projecto Sentry no futuro, define SENTRY_DSN
   no .env — essa variável tem sempre prioridade sobre este valor.
============================================================ */

const Sentry = require('@sentry/node');
const { redact } = require('../utils/redact');

const dsn = process.env.SENTRY_DSN
  || 'https://2277ef773e57c6353c15667567b6417d@o4511794897879040.ingest.us.sentry.io/4511794906529792';

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // 10% das transações — suficiente para ver padrões de performance
    // sem consumir a quota gratuita (5k erros/mês) só com tracing.
    tracesSampleRate: 0.1,
    // Nunca enviar PII por omissão (cookies, IP, headers de autenticação).
    sendDefaultPii: false,
    // Rede de segurança: mesmo que o SDK anexe o corpo/query/headers do pedido,
    // campos como password/token/secret/code chegam ao Sentry como [REDACTED].
    beforeSend(event) {
      try {
        if (event.request) {
          if (event.request.data) event.request.data = redact(event.request.data);
          if (event.request.headers) event.request.headers = redact(event.request.headers);
          if (event.request.cookies) event.request.cookies = '[REDACTED]';
          if (event.request.query_string && typeof event.request.query_string === 'object') {
            event.request.query_string = redact(event.request.query_string);
          }
        }
        if (event.extra) event.extra = redact(event.extra);
      } catch { /* nunca impedir o envio do erro por falha de redacção */ }
      return event;
    },
  });
}

module.exports = Sentry;
