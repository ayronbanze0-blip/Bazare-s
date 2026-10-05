'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateEnv } = require('../../src/config/env');

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  FRONTEND_URL: 'https://bazares.co.mz',
  ZUMBOPAY_WEBHOOK_SECRET: 'x'.repeat(20)
};

test('produção válida não tem erros', () => {
  assert.deepStrictEqual(validateEnv(base).errors, []);
});
test('produção sem FRONTEND_URL é erro', () => {
  const { errors } = validateEnv({ ...base, FRONTEND_URL: '' });
  assert.ok(errors.some((e) => e.includes('FRONTEND_URL')));
});
test('FRONTEND_URL com "*" é rejeitada', () => {
  assert.ok(validateEnv({ ...base, FRONTEND_URL: '*' }).errors.length > 0);
});
test('secrets JWT curtos ou iguais são erro em produção', () => {
  assert.ok(validateEnv({ ...base, JWT_ACCESS_SECRET: 'curto' }).errors.length > 0);
  assert.ok(validateEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET }).errors.length > 0);
});
