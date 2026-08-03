'use strict';

// ─────────────────────────────────────────────────────────────────
// MENTIONS ("@utilizador") — Fase 2
// Extrai handles "@username" de texto livre (comentários e
// publicações), resolve para utilizadores reais, grava a relação em
// Mention e dispara UMA notificação por menção nova (nunca duplica
// ao reenviar o mesmo texto, e reage corretamente à edição: menções
// removidas do texto são apagadas, menções novas são notificadas).
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');
const notifSvc = require('./notificationService');
const prisma = require('../config/database');

// username: letras/números/underscore/ponto, 3 a 30 caracteres.
// Exige que "@" não venha colado a outra letra/número (evita apanhar
// emails "foo@bar.com" ou preços "10@20") e para no fim de palavra.
const MENTION_RE = /(^|[^\w@])@([a-z0-9_.]{3,30})\b/gi;

/**
 * Devolve a lista de usernames (minúsculas, sem duplicados) mencionados
 * no texto, na ordem em que aparecem.
 */
function extractMentionUsernames(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    const uname = m[2].toLowerCase();
    if (!seen.has(uname)) { seen.add(uname); out.push(uname); }
  }
  return out;
}

/**
 * Sincroniza as menções de um comentário ou publicação com o texto
 * atual: cria as novas, apaga as que já não constam do texto, e
 * notifica APENAS quem foi mencionado de novo (evita notificação
 * duplicada ao gravar o mesmo comentário outra vez ou ao editar sem
 * mexer nas menções).
 *
 * @param {Object} p
 * @param {string} p.text - texto já sanitizado
 * @param {string} p.authorId - quem escreveu
 * @param {string} p.authorName - nome de quem escreveu (para a notificação)
 * @param {string} [p.commentId]
 * @param {string} [p.announcementId]
 * @param {string} p.link - link do conteúdo, para a notificação
 */
async function syncMentions({ text, authorId, authorName, commentId = null, announcementId = null, link }) {
  try {
    if (!commentId && !announcementId) return; // nada para associar
    const usernames = extractMentionUsernames(text);

    const where = commentId ? { commentId } : { announcementId };
    const existing = await prisma.mention.findMany({
      where,
      select: { id: true, mentionedUserId: true, mentionedUser: { select: { username: true } } }
    });

    if (!usernames.length) {
      // texto editado e já não menciona ninguém — limpa tudo
      if (existing.length) await prisma.mention.deleteMany({ where: { id: { in: existing.map(e => e.id) } } });
      return;
    }

    const targetUsers = await prisma.user.findMany({
      where: { username: { in: usernames, mode: 'insensitive' } },
      select: { id: true, username: true }
    });

    const targetLower = new Set(targetUsers.map(u => u.username.toLowerCase()));
    const existingLower = new Set(
      existing.map(e => (e.mentionedUser?.username || '').toLowerCase()).filter(Boolean)
    );

    // remove menções que já não estão no texto
    const toRemove = existing.filter(e => !targetLower.has((e.mentionedUser?.username || '').toLowerCase()));
    if (toRemove.length) {
      await prisma.mention.deleteMany({ where: { id: { in: toRemove.map(e => e.id) } } });
    }

    // cria + notifica só as genuinamente novas (ignora auto-menção)
    const newTargets = targetUsers.filter(
      u => u.id !== authorId && !existingLower.has(u.username.toLowerCase())
    );

    for (const u of newTargets) {
      try {
        await prisma.mention.create({
          data: { mentionedUserId: u.id, authorId, commentId, announcementId }
        });
        notifSvc.mentioned(u.id, authorName || 'Alguém', link).catch(() => {});
      } catch (err) {
        // corrida rara (duplo submit) cai no @@unique — não é erro fatal
        if (err.code !== 'P2002') logger.error(`[Mentions] create falhou: ${err.message}`);
      }
    }
  } catch (err) {
    // Menções nunca devem impedir a publicação do comentário/anúncio.
    logger.error(`[Mentions] syncMentions falhou: ${err.message}`);
  }
}

module.exports = { extractMentionUsernames, syncMentions };
