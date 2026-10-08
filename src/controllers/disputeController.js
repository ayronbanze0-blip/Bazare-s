'use strict';

const { ok, created } = require('../utils/response');
const { handle } = require('../utils/appError');
const V = require('../utils/validate');
const svc = require('../services/disputeService');

module.exports = {
  open: handle('Disputes.open', async (req, res) => created(res, { dispute: await svc.openDispute(req.user.id, V.id(req.params.orderId, 'orderId'), req.body) }, 'Disputa aberta. Vamos analisar.')),
  respond: handle('Disputes.respond', async (req, res) => ok(res, { dispute: await svc.respondDispute(req.user.id, V.id(req.params.id), req.body) }, 'Resposta enviada.')),
  cancel: handle('Disputes.cancel', async (req, res) => ok(res, await svc.cancelDispute(req.user.id, V.id(req.params.id)), 'Disputa cancelada.')),
  mine: handle('Disputes.mine', async (req, res) => ok(res, await svc.listMine(req.user.id, { as: 'buyer', ...req.query }))),
  received: handle('Disputes.received', async (req, res) => ok(res, await svc.listMine(req.user.id, { as: 'seller', ...req.query }))),
  getOne: handle('Disputes.get', async (req, res) => ok(res, { dispute: await svc.getOne(req.user, V.id(req.params.id)) })),
  adminList: handle('Disputes.adminList', async (req, res) => ok(res, await svc.adminList(req.query))),
  resolve: handle('Disputes.resolve', async (req, res) => ok(res, await svc.resolveDispute(req.user, V.id(req.params.id), req.body), 'Disputa resolvida.')),
  reasons: (req, res) => ok(res, { reasons: svc.REASONS, windowDays: Math.max(1, parseInt(process.env.DISPUTE_WINDOW_DAYS, 10) || 7) })
};
