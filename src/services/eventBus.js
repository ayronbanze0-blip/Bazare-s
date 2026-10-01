'use strict';

/**
 * Event bus interno — uma acção no domínio, várias consequências.
 *   bus.emit(EVENTS.ORDER_STATUS_CHANGED, { orderId, buyerId, sellerId, status, from })
 *
 * Os subscritores (realtime, etc.) são isolados: se um falhar, os outros e o pedido
 * original continuam. Nunca lança para quem emite. As notificações/emails/audit que já
 * existem nos controllers mantêm-se — o bus acrescenta camadas sem os substituir.
 */

const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const EVENTS = Object.freeze({
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  STOCK_UPDATED: 'STOCK_UPDATED',
  APP_COMMAND: 'APP_COMMAND'
});

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const on = (event, handler) => {
  emitter.on(event, (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((e) => logger.warn(`[EventBus] subscritor de ${event} falhou: ${e.message}`));
  });
};

const emit = (event, payload = {}) => {
  try { emitter.emit(event, payload); }
  catch (e) { logger.warn(`[EventBus] emit ${event} falhou: ${e.message}`); }
};

module.exports = { EVENTS, on, emit };
