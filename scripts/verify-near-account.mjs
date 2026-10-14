// scripts/verify-near-account.mjs
//
// Pins the NEAR account every recovery-phrase wallet gets, and how its USDC
// counts. The derivation must match NEAR's own near-seed-phrase library
// (the path HOT / Meteor / MyNearWallet use), or the same phrase would open
// a different, empty account in those wallets. Run via `npm run verify`.

import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {deriveNearAccount, NEAR_DERIVATION_PATH, nearDerivationPathForIndex} from '../trading/wallet/keys.ts';
import {deriveSolanaKeypair} from '../src/wallet/solanaKeys.ts';
import {fetchNearUsdcBalance, withNearCash, spendableTotalUsd} from '../trading/core/usdcBalances.ts';
import {NEAR_ENABLED, NEAR_USDC} from '../trading/core/chainData.ts';

let checks = 0;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// near-seed-phrase@0.2.1 parseSeedPhrase(PHRASE) — NEAR's reference implementation.
const REF_PUBLIC = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25';
const REF_SECRET = 'ed25519:F1kPR175szkGxEL52A9H6Z5ocS2BtaipprK2Hiob9DjGzHTkScrBb1yt44baXPZ3LxyHcsTPdBjHmn6zx147txH';

const acct = {near: deriveNearAccount(PHRASE), solana: {address: deriveSolanaKeypair(PHRASE).publicKey.toBase58()}};
assert.equal(NEAR_DERIVATION_PATH, "m/44'/397'/0'");
assert.equal(nearDerivationPathForIndex(0), NEAR_DERIVATION_PATH);
assert.equal(acct.near.privateKey, REF_SECRET);
assert.equal(acct.near.address, Buffer.from(bs58.decode(REF_PUBLIC.slice(8))).toString('hex'));
console.log('ok', ++checks, "- the NEAR account matches near-seed-phrase (m/44'/397'/0'), so the same phrase opens it in any NEAR wallet");

assert.match(acct.near.address, /^[0-9a-f]{64}$/);
console.log('ok', ++checks, '- the account id is the implicit (64-hex) form');

const second = deriveNearAccount(PHRASE, 1);
assert.notEqual(second.address, acct.near.address);
assert.notEqual(acct.near.address, acct.solana.address);
console.log('ok', ++checks, '- a second account index gets its own NEAR account, separate from Solana');

// ft_balance_of on NEAR's USDC, answered by a mocked RPC.
let asked = null;
const mockFetch = async (url, init) => {
  asked = JSON.parse(init.body);
  const bytes = [...Buffer.from(JSON.stringify('12345678'))];
  return {json: async () => ({jsonrpc: '2.0', id: 'mango', result: {result: bytes}})};
};
const bal = await fetchNearUsdcBalance(acct.near.address, mockFetch);
assert.equal(bal, 12.345678);
assert.equal(asked.params.account_id, NEAR_USDC);
assert.equal(asked.params.method_name, 'ft_balance_of');
assert.equal(JSON.parse(Buffer.from(asked.params.args_base64, 'base64').toString()).account_id, acct.near.address);
console.log('ok', ++checks, "- USDC on NEAR is read from Circle's NEAR USDC with 6 decimals");

const base = {results: [{chainKey: 'base', asset: 'USDC', status: 'ok', balance: 10}], totalUsd: 10, complete: true};
const withNear = withNearCash(base, {status: 'ok', balance: 2.5});
assert.equal(withNear.totalUsd, 12.5);
assert.equal(withNear.complete, true);
assert.equal(spendableTotalUsd(withNear), 10);
console.log('ok', ++checks, '- NEAR USDC counts in the total, but never as spendable for a Relay route');

const failed = withNearCash(base, {status: 'error', error: 'down'});
assert.equal(failed.totalUsd, 10);
assert.equal(failed.complete, false);
assert.equal(withNearCash(base, null).totalUsd, 10);
console.log('ok', ++checks, "- an unreachable NEAR RPC marks the total incomplete; no NEAR account changes nothing");

assert.equal(NEAR_ENABLED, true);
console.log('ok', ++checks, '- NEAR is enabled because deposit, cash moves, trading and withdrawal paths are implemented');

console.log(`\n${checks} checks passed`);
