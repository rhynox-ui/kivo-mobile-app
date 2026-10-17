import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {Keypair} from '@solana/web3.js';
import {privateKeyToAccount} from 'viem/accounts';
import {detectImportInput, parseWalletSecret, serializeWalletSecret, evmAccountFor, solanaKeypairFor, nearAccountFor} from '../src/wallet/walletSecret.ts';
import {deriveSolanaKeypair} from '../src/wallet/solanaKeys.ts';
import {deriveNearAccount} from '../trading/wallet/keys.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXED_EVM = '0x' + '2'.repeat(64);
const gen = () => FIXED_EVM;

// Recovery phrase: same addresses as the existing phrase wallet.
const phrase = detectImportInput(`  ${PHRASE.toUpperCase()} `, gen);
assert.equal(phrase.status, 'ok');
assert.equal(phrase.kind, 'mnemonic');
assert.equal(phrase.addresses[0].address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
assert.equal(phrase.addresses[1].address, deriveSolanaKeypair(PHRASE).publicKey.toBase58());
assert.equal(serializeWalletSecret(phrase.secret), PHRASE, 'phrase vaults keep their existing format');
assert.equal(detectImportInput('abandon abandon abandon', gen).status, 'incomplete');
assert.equal(detectImportInput(PHRASE.replace(/about$/, 'abandon'), gen).status, 'invalid');

// EVM key, with and without 0x.
const evmKey = '0x' + '1'.repeat(64);
for (const input of [evmKey, evmKey.slice(2)]) {
  const r = detectImportInput(input, gen);
  assert.equal(r.status, 'ok'); assert.equal(r.kind, 'evm'); assert.equal(r.generatesEvm, false);
  assert.equal(r.addresses[0].address, privateKeyToAccount(evmKey).address);
  const back = parseWalletSecret(serializeWalletSecret(r.secret));
  assert.equal(evmAccountFor(back).address, privateKeyToAccount(evmKey).address);
  assert.equal(solanaKeypairFor(back), null);
  assert.equal(nearAccountFor(back), null);
}
assert.equal(detectImportInput('0x1234', gen).status, 'incomplete');

// Solana key: base58 and JSON array; generated EVM disclosed.
const sol = Keypair.fromSeed(new Uint8Array(32).fill(7));
for (const input of [bs58.encode(sol.secretKey), JSON.stringify([...sol.secretKey])]) {
  const r = detectImportInput(input, gen);
  assert.equal(r.status, 'ok'); assert.equal(r.kind, 'solana'); assert.equal(r.generatesEvm, true);
  assert.equal(r.addresses[0].address, sol.publicKey.toBase58());
  const back = parseWalletSecret(serializeWalletSecret(r.secret));
  assert.equal(solanaKeypairFor(back).publicKey.toBase58(), sol.publicKey.toBase58());
  assert.equal(evmAccountFor(back).address, privateKeyToAccount(FIXED_EVM).address);
}
// Corrupted public half and 32-byte seeds are refused, not guessed.
const bad = new Uint8Array(sol.secretKey); bad[63] ^= 1;
assert.equal(detectImportInput(bs58.encode(bad), gen).status, 'invalid');
assert.equal(detectImportInput(bs58.encode(sol.secretKey.slice(0, 32)), gen).status, 'ambiguous');

// NEAR key round-trips to the implicit account.
const near = deriveNearAccount(PHRASE);
const n = detectImportInput(near.privateKey, gen);
assert.equal(n.status, 'ok'); assert.equal(n.kind, 'near');
assert.equal(n.addresses[0].address, near.address);
assert.deepEqual(nearAccountFor(parseWalletSecret(serializeWalletSecret(n.secret))), near);

assert.equal(detectImportInput('hello', gen).status, 'invalid');
assert.equal(detectImportInput('   ', gen).status, 'empty');
console.log('wallet import detection: ok');

// New imports: recovery phrase only. Every key format is refused with the explanation.
import {detectPhraseImport, PRIVATE_KEY_IMPORT_REFUSED} from '../src/wallet/walletSecret.ts';
assert.equal(detectPhraseImport(PHRASE).status, 'ok');
assert.equal(detectPhraseImport(PHRASE).kind, 'mnemonic');
assert.equal(detectPhraseImport('abandon').status, 'incomplete');
assert.equal(detectPhraseImport('abandon abandon abandon').status, 'incomplete');
assert.equal(detectPhraseImport(PHRASE.replace(/about$/, 'abandon')).status, 'invalid');
for (const key of [evmKey, evmKey.slice(2), bs58.encode(sol.secretKey), JSON.stringify([...sol.secretKey]), near.privateKey, bs58.encode(sol.secretKey.slice(0, 32)), '0x1234']) {
  const r = detectPhraseImport(key);
  assert.equal(r.status, 'invalid');
  assert.equal(r.message, PRIVATE_KEY_IMPORT_REFUSED);
}
console.log('phrase-only import: ok');
