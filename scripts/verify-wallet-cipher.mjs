import assert from 'node:assert/strict';
import { decryptWithKeyBytes, encryptWithKeyBytes, assertValidSecretRecord } from '../src/wallet/walletCipher.ts';

const key = new Uint8Array(32).fill(7);
const iv = new Uint8Array(12).fill(3);
const secret = 'kivo-wallet-cipher-regression';

const ciphertext = encryptWithKeyBytes(secret, key, iv);
assert.equal(decryptWithKeyBytes(ciphertext, key, iv), secret);

const tampered = new Uint8Array(ciphertext);
tampered[tampered.length - 1] ^= 1;
assert.throws(() => decryptWithKeyBytes(tampered, key, iv), /Incorrect password/);

const record = {
  iterations: 600_000,
  salt: Buffer.alloc(16, 1).toString('base64'),
  iv: Buffer.alloc(12, 2).toString('base64'),
  ciphertext: Buffer.alloc(16, 3).toString('base64'),
};
assert.doesNotThrow(() => assertValidSecretRecord(record));
assert.throws(() => assertValidSecretRecord({ ...record, iterations: 1 }), /iterations/);
assert.throws(() => assertValidSecretRecord({ ...record, salt: 'bad' }), /salt/);
assert.throws(() => assertValidSecretRecord({ ...record, iv: Buffer.alloc(11).toString('base64') }), /iv/);
assert.throws(() => assertValidSecretRecord({ ...record, ciphertext: Buffer.alloc(15).toString('base64') }), /ciphertext/);

console.log('Wallet cipher regression checks passed: AES-GCM roundtrip, tamper rejection, and record validation.');
