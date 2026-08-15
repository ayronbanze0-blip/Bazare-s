'use strict';

const { ok, created, badRequest, notFound, serverError } = require('../utils/response');
const logger = require('../utils/logger');
const prisma = require('../config/database');

// ─── POST /api/users/:id/block ─────────────────────────────────────
// Bloquear outro utilizador. Efeitos imediatos:
//  - deixa de seguir a loja dele (se seguia) e ele deixa de te seguir
//    (a relação de seguidor de uma pessoa bloqueada não faz sentido);
//  - o conteúdo dele desaparece do teu feed e vice-versa (blockService);
//  - nenhum dos dois consegue enviar mensagens ao outro (chatController).
const block = async (req, res) => {
  try {
    const { id: blockedId } = req.params;
    if (blockedId === req.user.id) return badRequest(res, 'Não pode bloquear-se a si mesmo.');

    const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true, bazar: { select: { id: true } } } });
    if (!target) return notFound(res, 'Utilizador não encontrado.');

    const myBazar = await prisma.user.findUnique({ where: { id: req.user.id }, select: { bazar: { select: { id: true } } } });

    await prisma.$transaction(async (tx) => {
      await tx.block.upsert({
        where: { blockerId_blockedId: { blockerId: req.user.id, blockedId } },
        update: {},
        create: { blockerId: req.user.id, blockedId }
      });

      // Remove qualquer relação de "seguir" nos dois sentidos — não faz
      // sentido continuar a seguir (ou ser seguido por) alguém bloqueado.
      if (target.bazar) {
        await tx.follow.deleteMany({ where: { userId: req.user.id, bazarId: target.bazar.id } });
      }
      if (myBazar?.bazar) {
        await tx.follow.deleteMany({ where: { userId: blockedId, bazarId: myBazar.bazar.id } });
      }
    });

    logger.info(`[Block] ${req.user.email} bloqueou ${blockedId}`);
    return created(res, {}, 'Utilizador bloqueado.');
  } catch (err) {
    logger.error(`[Block.block] ${err.message}`);
    return serverError(res);
  }
};

// ─── DELETE /api/users/:id/block ───────────────────────────────────
const unblock = async (req, res) => {
  try {
    const { id: blockedId } = req.params;
    await prisma.block.deleteMany({ where: { blockerId: req.user.id, blockedId } });
    return ok(res, {}, 'Utilizador desbloqueado.');
  } catch (err) {
    logger.error(`[Block.unblock] ${err.message}`);
    return serverError(res);
  }
};

// ─── GET /api/users/blocked ─────────────────────────────────────────
const myBlocked = async (req, res) => {
  try {
    const rows = await prisma.block.findMany({
      where: { blockerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { blocked: { select: { id: true, name: true, avatarUrl: true, role: true, bazar: { select: { id: true, name: true, slug: true } } } } }
    });
    return ok(res, { blocked: rows.map(r => ({ ...r.blocked, blockedAt: r.createdAt })) });
  } catch (err) {
    logger.error(`[Block.myBlocked] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { block, unblock, myBlocked };
