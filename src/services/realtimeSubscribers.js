'use strict';

/** Liga eventos do domínio a eventos Socket.IO (rooms `user:<id>`). Chamado uma vez no arranque. */

const bus = require('./eventBus');

const init = (io) => {
  const toUsers = (ids, name, data) => {
    [...new Set(ids.filter(Boolean))].forEach((id) => io.to(`user:${id}`).emit(name, data));
  };

  bus.on(bus.EVENTS.ORDER_STATUS_CHANGED, ({ orderId, buyerId, sellerId, status, from }) => {
    toUsers([buyerId, sellerId], 'order:updated', { orderId, status, from, at: new Date().toISOString() });
  });

  bus.on(bus.EVENTS.STOCK_UPDATED, ({ productId, stock, sellerId }) => {
    if (sellerId) toUsers([sellerId], 'stock:updated', { productId, stock });
  });

  // Backend → frontend: o servidor manda agir (o frontend escuta 'app:command' em Bazares.Backend, core.js).
  // userId definido = só esse utilizador (room user:<id>); sem userId = todos os ligados.
  bus.on(bus.EVENTS.APP_COMMAND, ({ command, userId }) => {
    if (userId) io.to(`user:${userId}`).emit('app:command', command);
    else io.emit('app:command', command);
  });

  bus.on(bus.EVENTS.PRODUCT_UPDATED, ({ productId, sellerId }) => {
    if (sellerId) toUsers([sellerId], 'product:updated', { productId });
  });
};

module.exports = { init };
