'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyGatewayError, friendlyGatewayMessage } = require('../../src/services/gatewayErrors');

test('Fraud_Clawback_Termination → conta restrita, sem retry', () => {
  const r = classifyGatewayError('The state tag Fraud_Clawback_Termination of the transaction credit party restricts the fund transfer-in and the transaction fails.');
  assert.strictEqual(r.code, 'RESTRICTED_ACCOUNT');
  assert.strictEqual(r.retryable, false);
  assert.ok(!/state tag|Fraud_Clawback/i.test(r.message), 'mensagem ao utilizador não pode ter o texto cru');
  assert.ok(/operadora/i.test(r.message));
});

test('saldo insuficiente, PIN, timeout', () => {
  assert.strictEqual(classifyGatewayError('Insufficient funds').code, 'INSUFFICIENT_FUNDS');
  assert.strictEqual(classifyGatewayError('Wrong PIN entered').code, 'WRONG_PIN');
  assert.strictEqual(classifyGatewayError('Request timed out').code, 'TIMEOUT');
});

test('mensagem desconhecida em inglês → genérica em português; em português mantém-se', () => {
  assert.strictEqual(classifyGatewayError('Something weird happened').code, 'GATEWAY_DECLINED');
  assert.ok(/operadora/.test(friendlyGatewayMessage('Something weird happened')));
  assert.strictEqual(friendlyGatewayMessage('Operação não autorizada'), 'Operação não autorizada');
  assert.ok(friendlyGatewayMessage(null).length > 10);
});
