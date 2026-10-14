import assert from 'node:assert/strict';
import { redactDiagnosticText } from '../src/debug/redactDiagnostics.ts';

const secretHex = 'a'.repeat(64);
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepayload';
const recovery = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const evmAddress = '0x' + '1'.repeat(40);
const solanaAddress = 'So11111111111111111111111111111111111111112';
const input = [
  'TypeError: normal application failure',
  'private key: ' + secretHex,
  'Authorization: Bearer abc.def_123-xyz',
  'token=' + jwt,
  'wallet=' + evmAddress,
  'mint=' + solanaAddress,
  'recovery phrase: ' + recovery,
  recovery,
].join('\\n');
const redacted = redactDiagnosticText(input);
assert.ok(redacted.includes('TypeError: normal application failure'));
assert.ok(!redacted.includes(secretHex));
assert.ok(!redacted.includes('abc.def_123-xyz'));
assert.ok(!redacted.includes(jwt));
assert.ok(!redacted.includes(evmAddress));
assert.ok(!redacted.includes(solanaAddress));
assert.ok(!redacted.includes(recovery));
assert.match(redacted, /REDACTED/);
assert.match(redacted, /REDACTED_POSSIBLE_RECOVERY_PHRASE/);
console.log('Crash diagnostics redaction checks passed.');
