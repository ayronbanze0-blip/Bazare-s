'use strict';

const { ok, created, badRequest, notFound, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

const prisma = require('../config/database');

// ─── Alvos denunciáveis ──────────────────────────────────────────
// `find` confirma que o alvo existe; `owner` (opcional) devolve o dono para
// impedir auto-denúncia. Nomes alternativos que o frontend possa enviar ficam
// em ALIASES.
const TARGETS = {
  PRODUCT:      { find: (id) => prisma.product.findUnique({ where: { id }, select: { id: true } }) },
  USER:         { find: (id) => prisma.user.findUnique({ where: { id }, select: { id: true } }), owner: (t) => t.id },
  BAZAR:        { find: (id) => prisma.bazar.findUnique({ where: { id }, select: { id: true } }) },
  ANNOUNCEMENT: { find: (id) => prisma.announcement.findUnique({ where: { id }, select: { id: true } }) },
  REEL:         { find: (id) => prisma.reel.findUnique({ where: { id }, select: { id: true } }) },
  STORY:        { find: (id) => prisma.story.findUnique({ where: { id }, select: { id: true } }) },
  COMMENT:      { find: (id) => prisma.comment.findUnique({ where: { id }, select: { id: true, userId: true } }), owner: (t) => t.userId },
  GROUP_POST:   { find: (id) => prisma.communityPost.findUnique({ where: { id }, select: { id: true, authorId: true } }), owner: (t) => t.authorId },
  COMMUNITY:    { find: (id) => prisma.community.findUnique({ where: { id }, select: { id: true, ownerId: true } }), owner: (t) => t.ownerId }
};

const ALIASES = {
  POST: 'ANNOUNCEMENT', ANUNCIO: 'ANNOUNCEMENT', PUBLICACAO: 'ANNOUNCEMENT',
  PRODUTO: 'PRODUCT', UTILIZADOR: 'USER', LOJA: 'BAZAR', HISTORIA: 'STORY',
  COMENTARIO: 'COMMENT', GROUP: 'COMMUNITY', COMUNIDADE: 'COMMUNITY',
  COMMUNITY_POST: 'GROUP_POST', GRUPO_POST: 'GROUP_POST'
};

// ─── Submit a report (qualquer conteúdo) ─────────────────────────
const submit = async (req, res) => {
  try {
    const { targetId } = req.body;
    const rawType = String(req.body.type || '').trim().toUpperCase();
    const type = ALIASES[rawType] || rawType;
    const reason = String(req.body.reason || '').trim();
    // Descrição passa a ser opcional (denúncia rápida de 1 toque); quando vem, mantém o mínimo.
    const descRaw = String(req.body.description || '').trim();

    if (!type || !targetId || !reason) return badRequest(res, 'Indique o que quer denunciar e o motivo.');
    const target = TARGETS[type];
    if (!target) return badRequest(res, 'Tipo de denúncia inválido.');
    if (reason.length < 3) return badRequest(res, 'Motivo demasiado curto.');
    if (descRaw && descRaw.length < 10) return badRequest(res, 'Descrição demasiado curta (mínimo 10 caracteres).');

    const targetRow = await target.find(String(targetId));
    if (!targetRow) return notFound(res, 'O conteúdo denunciado já não existe.');
    if (target.owner && target.owner(targetRow) === req.user.id) {
      return badRequest(res, 'Não pode denunciar o seu próprio conteúdo.');
    }

    // Evita denúncias repetidas do mesmo alvo pela mesma pessoa enquanto
    // a anterior ainda não foi analisada.
    const alreadyPending = await prisma.report.findFirst({
      where: { reporterId: req.user.id, type, targetId: String(targetId), status: 'PENDENTE' },
      select: { id: true }
    });
    if (alreadyPending) return badRequest(res, 'Já denunciou isto anteriormente — a sua denúncia está em análise.');

    const data = {
      reporterId: req.user.id,
      type,
      targetId: String(targetId),
      reason: reason.slice(0, 200),
      description: sanitize(descRaw || reason)
    };
    // Colunas antigas mantidas para o painel admin e consultas existentes
    if (type === 'PRODUCT') data.targetProductId = String(targetId);
    if (type === 'USER') data.targetUserId = String(targetId);

    const report = await prisma.report.create({ data });

    // Notifica admins (sem bloquear a resposta)
    prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      .then((admins) => admins.forEach((admin) => notifSvc.push(admin.id, {
        type: 'WARNING',
        title: 'Nova denúncia',
        message: `${type}: ${reason}`,
        link: '/admin/reports'
      })))
      .catch((e) => logger.warn(`[Reports] notificar admins falhou: ${e.message}`));

    logger.info(`[Reports] New report by ${req.user.email}: ${type} — ${reason}`);
    return created(res, { report }, 'Denúncia enviada. Obrigado por nos ajudar a manter a plataforma segura.');
  } catch (err) {
    logger.error(`[Reports.submit] ${err.message}`);
    return serverError(res);
  }
};

// ─── My submitted reports ─────────────────────────────────────────
const myReports = async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: { reporterId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    return ok(res, { reports });
  } catch (err) {
    logger.error(`[Reports.myReports] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { submit, myReports, TARGETS, ALIASES };
