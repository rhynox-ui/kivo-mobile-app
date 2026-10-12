// scripts/verify-one-click-deposits.mjs
//
// Pins src/core/oneClickDeposits.ts — the rules for paying a 1Click
// deposit address. Every case here is about not losing money: the
// signed quote is on disk before anything is sent, a quote can only be
// paid once even if the first attempt threw, the deadline is re-checked
// right before sending, and exactly quote.amountIn goes out. Quotes are
// signed with a throwaway key so the real firewall runs unmodified.
// Run via `npm run verify`.

import assert from 'node:assert/strict';
import {ed25519} from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {oneClickQuoteHash, OneClickQuoteError} from '../trading/core/oneClick.ts';
import {
  ONE_CLICK_POLL_GRACE_MS,
  OneClickDepositError,
  fundOneClickQuote,
  refreshOneClickSwap,
  shouldPollOneClickSwap,
} from '../trading/core/oneClickDeposits.ts';

let checks = 0;
const ok = name => console.log('ok', ++checks, `- ${name}`);

const secret = ed25519.utils.randomPrivateKey();
const KEY = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;
const sign = response => ({...response, signature: `ed25519:${bs58.encode(ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(response)), secret))}`});

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const USER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const FEES = [{recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 50}];

function makeQuote({amount = '25500000', deadline = '2026-09-27T13:00:00.000Z', depositAddress = DEPOSIT} = {}) {
  return sign({
    timestamp: '2026-09-27T11:59:58.000Z',
    signature: '',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:wrap.near',
      amount,
      refundTo: USER,
      refundType: 'ORIGIN_CHAIN',
      recipient: USER,
      recipientType: 'INTENTS',
      deadline,
      appFees: FEES,
    },
    quote: {
      depositAddress,
      amountIn: amount,
      amountInFormatted: '25.5',
      amountInUsd: '25.5',
      minAmountIn: amount,
      amountOut: '8400000000000000000000000',
      amountOutFormatted: '8.4',
      amountOutUsd: '25.3',
      minAmountOut: '8316000000000000000000000',
      deadline,
      timeEstimate: 30,
    },
  });
}

const expectedFor = quote => ({
  originAsset: quote.quoteRequest.originAsset,
  destinationAsset: quote.quoteRequest.destinationAsset,
  amount: quote.quoteRequest.amount,
  recipient: USER,
  recipientType: 'INTENTS',
  refundTo: USER,
  maxSlippageBps: 100,
  appFees: FEES,
  managerPublicKey: KEY,
});

function memoryStore() {
  const map = new Map();
  return {
    map,
    async get(address) {
      return map.get(address) ?? null;
    },
    async put(record) {
      map.set(record.depositAddress, structuredClone(record));
    },
  };
}

function baseArgs(quote, store, overrides = {}) {
  return {
    response: quote,
    expected: expectedFor(quote),
    originChainKey: 'base',
    originSymbol: 'USDC',
    originDecimals: 6,
    fromAddress: USER,
    store,
    now: () => T0,
    send: async () => '0xdeposit',
    ...overrides,
  };
}

// ---- happy path

{
  const quote = makeQuote();
  const store = memoryStore();
  const sent = [];
  const submitted = [];
  const record = await fundOneClickQuote(
    baseArgs(quote, store, {
      send: async (to, amount) => {
        const onDisk = store.map.get(DEPOSIT);
        assert.ok(onDisk, 'record must be stored before send');
        assert.equal(onDisk.broadcastAttempted, true);
        assert.equal(onDisk.quoteResponse.signature, quote.signature);
        sent.push([to, amount]);
        return '0xdeposit';
      },
      submitDepositTx: async (hash, address) => {
        submitted.push([hash, address]);
        throw new Error('1Click down');
      },
    }),
  );
  assert.deepEqual(sent, [[DEPOSIT, '25.5']]);
  ok('the signed quote is on disk before the deposit is sent');
  ok('exactly quote.amountIn is sent, to the signed deposit address');
  assert.equal(record.status, 'PENDING_DEPOSIT');
  assert.equal(record.depositTxHash, '0xdeposit');
  assert.deepEqual(store.map.get(DEPOSIT).depositTxHash, '0xdeposit');
  assert.deepEqual(submitted, [['0xdeposit', DEPOSIT]]);
  ok('the tx hash is stored and reported to 1Click; a failed report is harmless');

  await assert.rejects(fundOneClickQuote(baseArgs(quote, store)), OneClickDepositError);
  ok('a quote that was already paid cannot be paid again');
}

// ---- 18-decimal origin (BNB Chain USDC)

{
  const quote = makeQuote({amount: '1500000000000000000'});
  const store = memoryStore();
  const sent = [];
  await fundOneClickQuote(baseArgs(quote, store, {originChainKey: 'bnb', originDecimals: 18, send: async (to, amount) => (sent.push(amount), '0xbnb')}));
  assert.deepEqual(sent, ['1.5']);
  ok('amounts are formatted with the origin asset\'s own decimals (18 on BNB Chain)');
}

// ---- firewall runs first

{
  const quote = makeQuote();
  const tampered = {...quote, quote: {...quote.quote, depositAddress: '0x3333333333333333333333333333333333333333'}};
  const store = memoryStore();
  let called = false;
  await assert.rejects(fundOneClickQuote(baseArgs(tampered, store, {send: async () => ((called = true), 'x')})), OneClickQuoteError);
  assert.equal(called, false);
  assert.equal(store.map.size, 0);
  ok('a tampered quote is refused before anything is stored or sent');
}

// ---- send throws (possibly after broadcast)

{
  const quote = makeQuote();
  const store = memoryStore();
  await assert.rejects(fundOneClickQuote(baseArgs(quote, store, {send: async () => {
    throw new Error('receipt timeout');
  }})), /receipt timeout/);
  const failed = store.map.get(DEPOSIT);
  assert.equal(failed.status, 'SEND_FAILED');
  assert.equal(failed.broadcastAttempted, true);
  assert.equal(failed.lastError, 'receipt timeout');
  ok('a send that throws is kept as SEND_FAILED, not deleted');

  await assert.rejects(fundOneClickQuote(baseArgs(quote, store)), OneClickDepositError);
  ok('and cannot be retried, since the first transfer may already have gone out');

  const deadline = Date.parse(quote.quote.deadline);
  assert.equal(shouldPollOneClickSwap(failed, deadline + ONE_CLICK_POLL_GRACE_MS - 1), true);
  assert.equal(shouldPollOneClickSwap(failed, deadline + ONE_CLICK_POLL_GRACE_MS + 1), false);
  ok('its status keeps being checked until well past the deposit deadline');
}

// ---- deadline passes while the user was confirming

{
  const quote = makeQuote();
  const store = memoryStore();
  const times = [T0, T0, Date.parse(quote.quote.deadline) - 60_000];
  let called = false;
  await assert.rejects(
    fundOneClickQuote(baseArgs(quote, store, {now: () => times.shift() ?? T0, send: async () => ((called = true), 'x')})),
    OneClickQuoteError,
  );
  assert.equal(called, false);
  const record = store.map.get(DEPOSIT);
  assert.equal(record.broadcastAttempted, false);
  assert.equal(shouldPollOneClickSwap(record, T0), false);
  ok('the deadline is re-checked right before sending; a stale quote never broadcasts');
}

// ---- status tracking

{
  const quote = makeQuote();
  const store = memoryStore();
  const funded = await fundOneClickQuote(baseArgs(quote, store));
  assert.equal(shouldPollOneClickSwap(funded, T0), true);

  const success = await refreshOneClickSwap(funded, {
    store,
    now: () => T0 + 60_000,
    fetchStatus: async () => ({
      status: 'SUCCESS',
      updatedAt: '',
      quoteResponse: quote,
      swapDetails: {amountOutFormatted: '8.41', destinationChainTxHashes: [{hash: 'nearTx1', explorerUrl: ''}]},
    }),
  });
  assert.equal(success.status, 'SUCCESS');
  assert.equal(success.amountOutFormatted, '8.41');
  assert.deepEqual(success.destinationTxHashes, ['nearTx1']);
  assert.equal(success.depositTxHash, '0xdeposit');
  assert.equal(shouldPollOneClickSwap(success, T0), false);
  ok('a SUCCESS status is stored with the delivered amount and stops polling');

  const other = makeQuote({depositAddress: DEPOSIT, amount: '99000000'});
  await assert.rejects(
    refreshOneClickSwap(funded, {store, fetchStatus: async () => ({status: 'REFUNDED', updatedAt: '', quoteResponse: other})}),
    OneClickDepositError,
  );
  assert.equal(store.map.get(DEPOSIT).status, 'SUCCESS');
  ok('a status answer about a different quote is ignored');

  for (const status of ['REFUNDED', 'FAILED']) {
    assert.equal(shouldPollOneClickSwap({...funded, status}, T0), false);
  }
  for (const status of ['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING']) {
    assert.equal(shouldPollOneClickSwap({...funded, status}, T0 + 10 * 24 * 3600 * 1000), true);
  }
  ok('in-flight statuses keep polling; SUCCESS / REFUNDED / FAILED stop');
}

console.log(`\n${checks} checks passed`);
