'use strict';

/**
 * Rotas de webhook — montadas em app.js ANTES do express.json() global,
 * porque a verificação de assinatura HMAC da ZumboPay precisa do corpo
 * em bruto (raw bytes), não do JSON já interpretado.
 */

const router = require('express').Router();
const express = require('express');
const ctrl = require('../controllers/walletController');

// express.raw() preserva o corpo como Buffer em req.body; convertemos
// para string/JSON manualmente dentro do controller via req.rawBody.
router.post(
  '/zumbopay',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res, next) => {
    req.rawBody = req.body; // Buffer em bruto, usado para validar a assinatura
    try {
      req.body = req.body && req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    } catch {
      req.body = {};
    }
    next();
  },
  ctrl.zumboPayWebhook
);

module.exports = router;
