'use strict';

const { ok, notFound, badRequest, forbidden, serverError } = require('../utils/response');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const { shapePoll } = require('../services/pollService');
const affinitySvc = require('../services/affinityService');

// ─── PUBLIC: Ver uma sondagem sozinha (raramente usado — o feed já
// vem com a sondagem incluída dentro do Post; serve para refrescar o
// resultado de uma sondagem específica sem recarregar o Post todo) ──
const getOne = async (req, res) => {
  try {
    const poll = await prisma.poll.findUnique({ where: { id: req.params.pollId } });
    if (!poll) return notFound(res, 'Sondagem não encontrada.');
    return ok(res, { poll: await shapePoll(poll, req.user?.id) });
  } catch (err) {
    logger.error(`[Polls.getOne] ${err.message}`);
    return serverError(res);
  }
};

// ─── Votar/retirar voto ────────────────────────────────────────────
// Escolha única: votar noutra opção substitui a anterior; votar na
// mesma opção que já tinhas retira o voto. Escolha múltipla: cada
// opção é independente (toque = alterna só aquela).
const vote = async (req, res) => {
  try {
    const poll = await prisma.poll.findUnique({
      where: { id: req.params.pollId },
      include: { announcement: { select: { bazarId: true } } }
    });
    if (!poll) return notFound(res, 'Sondagem não encontrada.');
    if (poll.expiresAt && poll.expiresAt < new Date()) {
      return badRequest(res, 'Esta sondagem já terminou.');
    }

    const { optionId } = req.body;
    if (!optionId) return badRequest(res, 'Escolhe uma opção.');
    const option = await prisma.pollOption.findFirst({ where: { id: optionId, pollId: poll.id } });
    if (!option) return badRequest(res, 'Opção inválida.');

    const existing = await prisma.pollVote.findUnique({
      where: { optionId_userId: { optionId, userId: req.user.id } }
    });

    if (existing) {
      // Já tinha votado exactamente nesta opção — um segundo toque
      // retira o voto (dá para "desvotar", como reagir/desreagir).
      await prisma.pollVote.delete({ where: { id: existing.id } });
    } else {
      if (!poll.allowMultiple) {
        // Escolha única — remove qualquer voto anterior noutra opção
        // desta mesma sondagem antes de gravar o novo.
        await prisma.pollVote.deleteMany({ where: { pollId: poll.id, userId: req.user.id } });
      }
      await prisma.pollVote.create({ data: { pollId: poll.id, optionId, userId: req.user.id } });
      affinitySvc.bump(req.user.id, poll.announcement.bazarId, 'REACT').catch(() => {});
    }

    return ok(res, { poll: await shapePoll(poll, req.user.id) });
  } catch (err) {
    logger.error(`[Polls.vote] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { getOne, vote };
