import assert from 'node:assert/strict';
import { assertKivoMessage } from '../src/state/signGuardRules.ts';

const address = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const issued = new Date().toISOString();
const buildMessage = (overrides = {}) => {
  const fields = {
    URI: 'https://kivotrade.site',
    Version: '1',
    'Chain ID': '1',
    Nonce: 'testNonce_123456',
    Issued: issued,
    ...overrides,
  };
  return [
    'Kivo wants you to sign in with your wallet.',
    '',
    'Address: ' + address,
    '',
    'URI: ' + fields.URI,
    'Version: ' + fields.Version,
    'Chain ID: ' + fields['Chain ID'],
    'Nonce: ' + fields.Nonce,
    'Issued: ' + fields.Issued,
    '',
    'This signature only proves you control this wallet. It cannot move funds or approve transactions.',
  ].join('\\n');
};

assert.doesNotThrow(() => assertKivoMessage(buildMessage(), 'sign-in', address));
assert.throws(() => assertKivoMessage(buildMessage({ URI: 'https://attacker.example' }), 'sign-in', address));
assert.throws(() => assertKivoMessage(buildMessage(), 'sign-in', '0x0000000000000000000000000000000000000000'));
assert.throws(() => assertKivoMessage(buildMessage({ Nonce: 'short' }), 'sign-in', address));
assert.throws(() => assertKivoMessage(buildMessage({ Issued: '2000-01-01T00:00:00.000Z' }), 'sign-in', address));
assert.throws(() => assertKivoMessage(buildMessage(), 'profile', address));

console.log('Sign guard regression checks passed: valid sign-in accepted; origin, address, nonce, age, and message-kind mismatches rejected.');
