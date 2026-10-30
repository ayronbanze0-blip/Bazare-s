'use strict';

const prisma = require('../config/database');
const logger = require('../utils/logger');
const { ok, notFound, serverError } = require('../utils/response');
const trust = require('../services/sellerTrustService');

// GET /api/bazars/:idOrSlug/trust — público (selo e números; sem dicas nem nível "atenção")
const publicTrust = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const bazar = await prisma.bazar.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], active: true },
      select: { sellerId: true }
    });
    if (!bazar) return notFound(res, 'Loja não encontrada.');
    return ok(res, { trust: trust.toPublic(await trust.trustSummary(bazar.sellerId)) });
  } catch (err) {
    logger.error(`[Trust.public] ${err.message}`);
    return serverError(res);
  }
};

// GET /api/seller/trust — só o dono: nível real + dicas para melhorar
const ownerTrust = async (req, res) => {
  try {
    return ok(res, { trust: await trust.trustSummary(req.user.id) });
  } catch (err) {
    logger.error(`[Trust.owner] ${err.message}`);
    return serverError(res);
  }
};

module.exports = { publicTrust, ownerTrust };
