'use strict';

const { envEnabled } = require('../config/features');
const { errorBody } = require('../utils/response');

/**
 * Bloqueia (503 FEATURE_DISABLED) as rotas de uma funcionalidade desligada.
 *   1. Variável de ambiente ENABLE_X=false (fiável, não depende da BD).
 *   2. Flag na BD `enable_x` = desligada (painel admin; cache de 30 s; fail-open se a BD falhar).
 * `except`: regex sobre req.path (relativo ao mount) que NÃO é bloqueado — ex.: /admin/* do premium.
 * Webhooks de pagamento nunca passam por aqui (têm de continuar a confirmar pagamentos).
 */
const requireFeature = (name, { except } = {}) => async (req, res, next) => {
  if (except && except.test(req.path)) return next();

  const disabled = () => res.status(503).json(errorBody(res, 'FEATURE_DISABLED', 'Funcionalidade temporariamente indisponível.'));

  if (!envEnabled(name)) return disabled();
  try {
    // require lazy: mantém o resto do módulo testável sem BD.
    const { isEnabled } = require('../services/featureFlags');
    if (!(await isEnabled(name.toLowerCase(), true))) return disabled();
  } catch { /* BD indisponível → fail-open: só o env desliga de forma fiável */ }
  return next();
};

module.exports = { requireFeature };
