'use strict';

/**
 * Push Service — notificações push via Firebase Cloud Messaging (FCM).
 *
 * Complementa o notificationService (que já grava na BD e emite em
 * tempo real via Socket.IO enquanto a app está aberta): este serviço
 * entrega a MESMA notificação como push nativo, mesmo com a app
 * fechada ou em background.
 *
 * Variáveis de ambiente necessárias (ver env.example):
 *   FIREBASE_PROJECT_ID   — ID do projecto Firebase
 *   FIREBASE_CLIENT_EMAIL — email da conta de serviço (Firebase Console →
 *                            Definições do projecto → Contas de serviço →
 *                            Gerar nova chave privada)
 *   FIREBASE_PRIVATE_KEY  — chave privada da mesma conta de serviço.
 *                            No Render/Railway, cola o valor com os \n
 *                            literais (o código faz o replace abaixo);
 *                            localmente, no .env, usa aspas e \n também.
 *
 * Sem estas variáveis definidas, isConfigured() devolve false e o resto
 * da app continua a funcionar normalmente — só sem push nativo (o
 * Socket.IO em tempo real e as notificações in-app continuam intactos).
 */

const logger = require('../utils/logger');

let admin = null;
let app = null;
let initTried = false;

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

const isConfigured = () => Boolean(PROJECT_ID && CLIENT_EMAIL && PRIVATE_KEY);

// ─── Lazy init — só carrega firebase-admin e inicializa a app na
// primeira vez que é preciso enviar algo, para não atrasar o arranque
// do servidor nem rebentar se o pacote não estiver instalado ainda. ──
const getApp = () => {
  if (app) return app;
  if (initTried) return null;
  initTried = true;

  if (!isConfigured()) {
    logger.warn('[Push] Firebase não configurado (variáveis FIREBASE_* em falta) — push nativo desactivado.');
    return null;
  }

  try {
    admin = require('firebase-admin');
    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId: PROJECT_ID,
            clientEmail: CLIENT_EMAIL,
            // No painel do Render/Railway a variável de ambiente vem com
            // "\n" literais em vez de quebras de linha reais — a chave
            // PEM só é válida com quebras de linha reais.
            privateKey: PRIVATE_KEY.replace(/\\n/g, '\n')
          })
        });
    logger.info('[Push] Firebase Admin inicializado.');
  } catch (err) {
    logger.error(`[Push] Falha ao inicializar Firebase Admin: ${err.message}`);
    app = null;
  }
  return app;
};

/**
 * Envia um push para um conjunto de tokens FCM. Devolve os tokens que
 * a Firebase reportou como inválidos/expirados (para o chamador os
 * remover da BD) — sem isto, a tabela DeviceToken acumulava lixo de
 * dispositivos desinstalados/reinstalados para sempre.
 */
const sendToTokens = async (tokens, { title, body, link }) => {
  const firebaseApp = getApp();
  if (!firebaseApp || !tokens?.length) return { successCount: 0, invalidTokens: [] };

  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: link ? { link } : {},
      webpush: {
        fcmOptions: link ? { link } : undefined,
        notification: { icon: '/icons/icon-192.png' }
      }
    });

    const invalidTokens = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || '';
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(tokens[i]);
      }
    });

    return { successCount: res.successCount, invalidTokens };
  } catch (err) {
    logger.error(`[Push] sendEachForMulticast falhou: ${err.message}`);
    return { successCount: 0, invalidTokens: [] };
  }
};

/**
 * Envia push para todos os dispositivos registados de um utilizador,
 * e já limpa da BD os tokens que a Firebase reportou como inválidos.
 * Nunca lança — chamado em "fire and forget" a partir do
 * notificationService, para uma falha no push nunca impedir o resto
 * do fluxo (ex.: criar a encomenda) de completar.
 */
const sendToUser = async (prisma, userId, { title, body, link }) => {
  if (!isConfigured()) return;
  try {
    const devices = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
    if (!devices.length) {
      logger.info(`[Push] Utilizador ${userId} não tem dispositivos registados — nada a enviar.`);
      return;
    }

    const { successCount, invalidTokens } = await sendToTokens(devices.map(d => d.token), { title, body, link });
    logger.info(`[Push] Enviado para ${userId}: ${successCount}/${devices.length} dispositivo(s) com sucesso.`);

    if (invalidTokens.length) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
      logger.info(`[Push] ${invalidTokens.length} token(s) inválido(s) removido(s) para o utilizador ${userId}.`);
    }
  } catch (err) {
    logger.error(`[Push] sendToUser falhou para ${userId}: ${err.message}`);
  }
};

module.exports = { isConfigured, sendToTokens, sendToUser };
