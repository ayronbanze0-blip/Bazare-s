'use strict';

const { PrismaClient } = require('@prisma/client');
const { ok, created, badRequest, serverError } = require('../utils/response');
const { sanitize } = require('../utils/helpers');
const notifSvc = require('../services/notificationService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─── Submit a report (product or user) ───────────────────────────
const submit = async (req, res) => {
  try {
    const { type, targetId, reason, description } = req.body;
    if (!type || !targetId || !reason || !description) return badRequest(res, 'Preencha todos os campos.');
    if (!['PRODUCT', 'USER', 'BAZAR'].includes(type)) return badRequest(res, 'Tipo de denúncia inválido.');

    const data = {
      reporterId: req.user.id,
      type,
      reason,
      description: sanitize(description)
    };

    if (type === 'PRODUCT') data.targetProductId = targetId;
    else data.targetUserId = targetId;

    const report = await prisma.report.create({ data });

    // Notify all admins
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      notifSvc.push(admin.id, {
        type: 'WARNING',
        title: 'Nova denúncia',
        message: `${type}: ${reason}`,
        link: '/admin/reports'
      });
    }

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
      orderBy: { createdAt: 'desc' }
    });
    return ok(res, { reports });
  } catch (err) {
    logger.error(`[Reports.myReports] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { submit, myReports };
