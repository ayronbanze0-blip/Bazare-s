'use strict';

/**
 * Chama um handler Express EXISTENTE (req,res) dentro do processo e devolve
 * { status, ok, data } — sem duplicar a lógica de negócio dos controllers
 * (bloqueios, engagement, favoritos, moderação, etc. continuam a viver só lá).
 * Usado pelos endpoints de "experiência" (/home, /explore, /:id/view).
 */
const internalCall = (handler, base, { params = {}, query = {} } = {}) =>
  new Promise((resolve) => {
    const req = {
      user: base.user,
      id: base.id,
      headers: base.headers || {},
      params,
      query,
      body: {}
    };
    const out = { status: 200 };
    const res = {
      req,
      status(code) { out.status = code; return res; },
      json(body) {
        resolve({ status: out.status, ok: !!(body && body.success), data: body && body.data, body });
        return res;
      },
      send() { resolve({ status: out.status, ok: out.status < 400, data: null }); return res; }
    };
    Promise.resolve(handler(req, res)).catch(() => resolve({ status: 500, ok: false, data: null }));
  });

// Valor de uma secção, ou fallback se essa secção falhou — uma secção
// partida nunca deve derrubar a Home inteira.
const pick = (settled, key, fallback) => {
  const r = settled && settled.status === 'fulfilled' ? settled.value : null;
  return r && r.ok && r.data && r.data[key] !== undefined ? r.data[key] : fallback;
};

module.exports = { internalCall, pick };
