'use strict';

const logger = require('./logger');

// Resiliência das LEITURAS: corre uma parte OPCIONAL de um endpoint (contagens, estado de "seguir"/
// "favorito", afinidade, bloqueios…) isolada das restantes. Se falhar (ex.: tabela/coluna em falta
// na BD, serviço lento), regista a etapa exacta no log e devolve o `fallback`, em vez de deitar
// abaixo o ecrã inteiro com 500.
//
// NÃO usar em escritas, pagamentos, carteira, encomendas ou autenticação: aí uma falha parcial
// tem de ser erro, não "continuar sem ela".
const makeStage = (tag) => async (name, fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    logger.error(`[${tag}] etapa "${name}" falhou (a continuar sem ela): ${err.code ? err.code + ' · ' : ''}${err.message}`);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
};

module.exports = { makeStage };
