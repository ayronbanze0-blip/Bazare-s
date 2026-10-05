'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isPublicHttpsUrl } = require('../../src/utils/safeUrl');

test('aceita https para domínios públicos', () => {
  assert.ok(isPublicHttpsUrl('https://res.cloudinary.com/demo/image/upload/a.jpg'));
  assert.ok(isPublicHttpsUrl('https://bazares.co.mz/x'));
});
test('recusa http, esquemas perigosos e não-strings', () => {
  for (const u of ['http://a.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.com', {}, null, undefined, 42]) {
    assert.strictEqual(isPublicHttpsUrl(u), false, String(u));
  }
});
test('recusa destinos internos (SSRF)', () => {
  for (const u of [
    'https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/',
    'https://intranet/', 'https://db.internal/', 'https://printer.local/'
  ]) assert.strictEqual(isPublicHttpsUrl(u), false, u);
});
test('recusa credenciais, portas não padrão e URLs enormes', () => {
  assert.strictEqual(isPublicHttpsUrl('https://user:pw@a.com/'), false);
  assert.strictEqual(isPublicHttpsUrl('https://a.com:8443/'), false);
  assert.strictEqual(isPublicHttpsUrl('https://a.com/' + 'x'.repeat(600)), false);
});
