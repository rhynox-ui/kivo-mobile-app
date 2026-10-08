// scripts/verify-one-click.mjs
//
// Pins src/core/oneClick.ts: the quote-signature port and the
// pre-deposit firewall. The fixtures are real quotes signed by 1Click's
// STAGING manager key, copied from the official SDK's own test suite
// (defuse-protocol/one-click-sdk-typescript,
// src/__tests__/quote-signature.test.ts, ISC license) — so a passing
// signature check here means this port hashes exactly what 1Click signs,
// not just that it agrees with itself. Run via `npm run verify`.

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ed25519} from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  ONE_CLICK_MANAGER_PUB_KEY,
  OneClickQuoteError,
  assertOneClickDepositWindowOpen,
  assertOneClickQuoteSafeToFund,
  findOneClickAssetId,
  isNearIntentsAccountId,
  isOneClickStatusFinal,
  oneClickAppFees,
  ONE_CLICK_FEE_ACCOUNT,
  oneClickQuoteHash,
  stableStringify,
  verifyOneClickQuoteSignature,
} from '../trading/core/oneClick.ts';

const require = createRequire(import.meta.url);
const jsonStableStringify = require('json-stable-stringify');

let checks = 0;
const ok = name => console.log('ok', ++checks, `- ${name}`);

const STAGING_KEY = 'ed25519:5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co';

const REQUEST = {
  dry: false,
  depositMode: 'SIMPLE',
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: '1cs_v1:btc:native:coin',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near',
  amount: '10000',
  refundTo: 'bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly',
  refundType: 'ORIGIN_CHAIN',
  recipient: '0xcac3C41676deF4FE375E57118f3eB83A99105577',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-06-23T19:00:00.000Z',
  confidentiality: 'public',
  quoteWaitingTimeMs: 0,
  appFees: [{recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 10}],
};

const NON_DRY = {
  correlationId: 'd4f1b110-46cc-4682-aa3f-44d81ffe4b80',
  timestamp: '2026-06-23T17:10:41.104Z',
  signature: 'ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9',
  quoteRequest: REQUEST,
  quote: {
    amountIn: '10000',
    amountInFormatted: '0.0001',
    amountInUsd: '6.237600000000',
    minAmountIn: '10000',
    amountOut: '5931560',
    amountOutFormatted: '5.93156',
    amountOutUsd: '5.925171709880',
    minAmountOut: '5872244',
    timeEstimate: 812,
    refundFee: '1900',
    withdrawFee: '300000',
    deadline: '2026-06-26T19:00:00.000Z',
    timeWhenInactive: '2026-06-26T19:00:00.000Z',
    depositAddress: 'bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw',
  },
};

const DRY = {
  correlationId: '7d6d78f0-601f-4022-9735-854a22ed9dcb',
  timestamp: '2026-06-23T17:10:55.616Z',
  signature: 'ed25519:3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5',
  quoteRequest: {...REQUEST, dry: true},
  quote: {
    amountIn: '10000',
    amountInFormatted: '0.0001',
    amountInUsd: '6.237600000000',
    minAmountIn: '10000',
    amountOut: '5935024',
    amountOutFormatted: '5.935024',
    amountOutUsd: '5.928631979152',
    minAmountOut: '5875673',
    timeEstimate: 812,
    refundFee: '1900',
    withdrawFee: '300000',
  },
};

// Same quote as it comes back from /v0/status: nulls instead of absent
// fields, and a different correlationId — must still verify.
const FROM_STATUS = {
  ...NON_DRY,
  correlationId: 'a60bbb06-4609-4976-873a-1f2f72c080e4',
  quoteRequest: {...REQUEST, quoteWaitingTimeMs: undefined, virtualChainRecipient: null, virtualChainRefundRecipient: null, referral: null},
};

// ---- canonical JSON

for (const sample of [NON_DRY, DRY, {b: [1, undefined, {z: null, a: 'x'}], a: undefined, c: 'é"\n'}]) {
  assert.equal(stableStringify(sample), jsonStableStringify(sample));
}
ok('stableStringify matches json-stable-stringify byte for byte');

// ---- signature against real 1Click-signed fixtures

assert.equal(verifyOneClickQuoteSignature(NON_DRY, STAGING_KEY), true);
ok('a real staging-signed quote verifies');
assert.equal(verifyOneClickQuoteSignature(DRY, STAGING_KEY), true);
ok('a real staging-signed dry quote verifies');
assert.equal(verifyOneClickQuoteSignature(FROM_STATUS, STAGING_KEY), true);
ok('the same quote as returned by /v0/status verifies');
assert.equal(verifyOneClickQuoteSignature({...NON_DRY, quoteRequest: {...REQUEST, appFees: [{recipient: 'attacker.near', fee: 500}]}}, STAGING_KEY), true);
ok('appFees are outside the signature (so the firewall must compare them itself)');

assert.equal(verifyOneClickQuoteSignature(NON_DRY), false);
ok('a staging signature does not pass against the pinned production key');
assert.equal(ONE_CLICK_MANAGER_PUB_KEY, 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc');
ok('the pinned production key matches the official SDK');

const tamperings = {
  'deposit address': {...NON_DRY, quote: {...NON_DRY.quote, depositAddress: 'bc1q0000000000000000000000000000000000000000'}},
  recipient: {...NON_DRY, quoteRequest: {...REQUEST, recipient: '0x000000000000000000000000000000000000dEaD'}},
  'refund address': {...NON_DRY, quoteRequest: {...REQUEST, refundTo: 'bc1qattacker'}},
  'minimum output': {...NON_DRY, quote: {...NON_DRY.quote, minAmountOut: '1'}},
  deadline: {...NON_DRY, quote: {...NON_DRY.quote, deadline: '2030-01-01T00:00:00.000Z'}},
  'empty signature': {...NON_DRY, signature: ''},
  'malformed signature': {...NON_DRY, signature: 'not-a-valid-signature'},
};
for (const [field, tampered] of Object.entries(tamperings)) {
  assert.equal(verifyOneClickQuoteSignature(tampered, STAGING_KEY), false, field);
}
ok(`tampering with any signed field fails (${Object.keys(tamperings).join(', ')})`);

// Independent round trip: sign oneClickQuoteHash with a fresh key.
const secret = ed25519.utils.randomPrivateKey();
const pub = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;
const selfSigned = {...NON_DRY, signature: `ed25519:${bs58.encode(ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(NON_DRY)), secret))}`};
assert.equal(verifyOneClickQuoteSignature(selfSigned, pub), true);
assert.equal(verifyOneClickQuoteSignature(selfSigned, STAGING_KEY), false);
ok('verification is bound to the key it is given');

// ---- firewall

const expected = {
  originAsset: REQUEST.originAsset,
  destinationAsset: REQUEST.destinationAsset,
  amount: '10000',
  recipient: '0xCAC3c41676def4fe375e57118f3eb83a99105577',
  recipientType: 'DESTINATION_CHAIN',
  refundTo: REQUEST.refundTo,
  maxSlippageBps: 100,
  appFees: REQUEST.appFees,
  managerPublicKey: STAGING_KEY,
  now: Date.parse('2026-06-23T17:11:00.000Z'),
};

assertOneClickQuoteSafeToFund(NON_DRY, expected);
ok('a genuine quote matching the request passes (EVM recipient compared case-insensitively)');

function rejects(name, response, overrides = {}) {
  assert.throws(() => assertOneClickQuoteSafeToFund(response, {...expected, ...overrides}), OneClickQuoteError, name);
}
rejects('signed by staging, checked against production', NON_DRY, {managerPublicKey: undefined});
rejects('tampered deposit address', tamperings['deposit address']);
rejects('dry quote', DRY);
rejects('different amount requested', NON_DRY, {amount: '20000'});
rejects('different recipient requested', NON_DRY, {recipient: '0x000000000000000000000000000000000000dEaD'});
rejects('different refund address requested', NON_DRY, {refundTo: 'bc1qsomeoneelse'});
rejects('different destination asset', NON_DRY, {destinationAsset: 'nep141:wrap.near'});
rejects('slippage above what the user set', NON_DRY, {maxSlippageBps: 50});
rejects('app fees changed in transit', {...NON_DRY, quoteRequest: {...REQUEST, appFees: [{recipient: 'attacker.near', fee: 500}]}});
rejects('app fees dropped', {...NON_DRY, quoteRequest: {...REQUEST, appFees: []}});
rejects('deadline already inside the safety margin', NON_DRY, {now: Date.parse('2026-06-26T18:55:00.000Z')});
rejects('missing response', null);
ok('the firewall refuses every mismatch (12 cases)');

assert.throws(() => assertOneClickDepositWindowOpen({...NON_DRY.quote, deadline: undefined}), OneClickQuoteError);
assertOneClickDepositWindowOpen(NON_DRY.quote, Date.parse('2026-06-26T18:00:00.000Z'));
ok('the deposit window check needs a real deadline and a margin before it');

// ---- helpers

const tokens = [
  {assetId: 'nep141:base-usdc', blockchain: 'base', symbol: 'USDC', decimals: 6, price: 1, priceUpdatedAt: '', contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'},
  {assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18, price: 3000, priceUpdatedAt: ''},
  {assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, price: 3, priceUpdatedAt: '', contractAddress: 'wrap.near'},
];
assert.equal(findOneClickAssetId(tokens, 'base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), 'nep141:base-usdc');
assert.equal(findOneClickAssetId(tokens, 'eth', null, 'ETH'), 'nep141:eth.omft.near');
assert.equal(findOneClickAssetId(tokens, 'eth', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), null);
assert.equal(findOneClickAssetId(tokens, 'base', null, 'ETH'), null);
ok('asset ids resolve only on an exact chain + contract (or native symbol) match');

assert.deepEqual(['SUCCESS', 'REFUNDED', 'FAILED'].map(isOneClickStatusFinal), [true, true, true]);
assert.deepEqual(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'].map(isOneClickStatusFinal), [false, false, false, false]);
ok('only SUCCESS / REFUNDED / FAILED end status polling');

// ---- fee

const FEE_ACCOUNT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
assert.deepEqual(oneClickAppFees(100, FEE_ACCOUNT), [{recipient: FEE_ACCOUNT, fee: 50}]);
assert.deepEqual(oneClickAppFees(undefined, FEE_ACCOUNT), [{recipient: FEE_ACCOUNT, fee: 50}]);
assert.deepEqual(oneClickAppFees(10_000, FEE_ACCOUNT), [{recipient: FEE_ACCOUNT, fee: 50}]);
ok('NEAR routes charge the same 0.5% (50 bps) as Relay trades');
assert.deepEqual(oneClickAppFees(20_000, FEE_ACCOUNT), [{recipient: FEE_ACCOUNT, fee: 25}]);
assert.deepEqual(oneClickAppFees(100_000, FEE_ACCOUNT), [{recipient: FEE_ACCOUNT, fee: 5}]);
ok('and the same $50 cap on large trades');

assert.equal(ONE_CLICK_FEE_ACCOUNT, 'widekingdom6862.near');
assert.equal(isNearIntentsAccountId(ONE_CLICK_FEE_ACCOUNT), true);
assert.deepEqual(oneClickAppFees(100), [{recipient: 'widekingdom6862.near', fee: 50}]);
assert.throws(() => oneClickAppFees(100, null));
ok("fees go to Mango's NEAR account; with no account, no quote can be built");

for (const good of [FEE_ACCOUNT, 'mango.near', 'fees.mango-protocol.near', '0xf07becc2401a646fff10d10b969ef18b03582e88']) {
  assert.equal(isNearIntentsAccountId(good), true, good);
}
for (const bad of ['', 'Mango.near', '0xF07BECC2401A646FFF10D10B969EF18B03582E88', 'a', 'bad..near', 'x'.repeat(65), null]) {
  assert.equal(isNearIntentsAccountId(bad), false, String(bad));
  assert.throws(() => oneClickAppFees(100, bad));
}
ok('fee account must be a well-formed NEAR Intents account id');

console.log(`\n${checks} checks passed`);
