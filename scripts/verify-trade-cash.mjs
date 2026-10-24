// Checks the Trade cash rules (owner's final product rules):
//   - the Trade ticket's spendable balance is USDC (USDG on Robinhood) ONLY,
//     across every supported network, Solana home included;
//   - a buy never draws from native coins (SOL/ETH/BNB) or other tokens;
//   - a buy larger than any one network's USDC splits across networks;
//   - a network that can't be read is an error, never $0;
//   - USDC on other networks moves home to Solana fee-free (0 app fee) yet
//     asks Kivo's server for sponsorship with a proof that the Solana
//     recipient is the user's own wallet; native coins are never swept.
// Run: npm run verify:trade-cash
import assert from 'node:assert/strict';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {cashOnly, onlyCash, spendOrder, totalSpendableUsd} from '../trading/kivo/spendable.ts';
import {buyPool, legNeedsSponsorship} from '../trading/kivo/unified.ts';
import {sweepCandidates} from '../trading/kivo/sweep.ts';
import {homeMoveFlags} from '../trading/kivo/convert.ts';
import {homeMoveMessage, homeProofFor, cachedHomeProof, clearHomeProofs} from '../trading/kivo/homeProof.ts';
import {configureRelayEndpoints, getRelayQuote} from '../trading/core/relayQuote.ts';
import {TOKEN_ADDRESSES} from '../trading/core/chainData.ts';

const usdcRow = (chainKey, amount, symbol = 'USDC') => ({chainKey, status: 'ok', balance: {chainKey, tokenAddress: `${chainKey}-${symbol}`, symbol, raw: 0n, decimals: 6, amount}});

// --- Spendable = USDC on every network (the wallet's "Total cash") ---------
// The owner's wallet: 2.304 USDC on Solana plus $5.67 on other networks.
const rows = [usdcRow('solana', 2.304), usdcRow('base', 3.5), usdcRow('bnb', 2.17), usdcRow('robinhood', 0, 'USDG'), {chainKey: 'arbitrum', status: 'error', error: 'timeout'}];
const cash = cashOnly(rows);
assert.ok(Math.abs(totalSpendableUsd(cash) - (2.304 + 3.5 + 2.17)) < 1e-9, 'available = all USDC across networks');
assert.deepEqual(cash.assets.map(a => a.kind), ['cash', 'cash', 'cash']);
assert.deepEqual(cash.errors.map(e => e.chainKey), ['arbitrum'], 'an unreadable network is an error, not $0');
// Arc keeps its USDC gas reserve.
assert.ok(Math.abs(totalSpendableUsd(cashOnly([usdcRow('arc', 1)])) - 0.99) < 1e-9);

// A mixed balance (Convert's view) keeps only cash for trading.
const asset = (chainKey, symbol, kind, valueUsd, address = `${chainKey}-${symbol}`) => ({chainKey, address, symbol, decimals: 6, kind, amount: valueUsd, spendableAmount: valueUsd, priceUsd: 1, valueUsd});
const mixed = {assets: [asset('base', 'ETH', 'native', 50), asset('solana', 'SOL', 'native', 40), asset('bnb', 'USDT', 'stable', 30), asset('base', 'USDC', 'cash', 10)], errors: [{chainKey: 'base', symbol: 'ETH', error: 'x'}, {chainKey: 'bnb', symbol: 'USDC', error: 'y'}]};
assert.deepEqual(onlyCash(mixed).assets.map(a => a.symbol), ['USDC']);
assert.deepEqual(onlyCash(mixed).errors.map(e => e.symbol), ['USDC']);

// --- Buys draw only USDC, split across networks -----------------------------
const token = {chainKey: 'arbitrum', tokenAddress: '0x1111111111111111111111111111111111111111'};
const pool = buyPool(mixed, token, 'So1');
assert.deepEqual(pool.map(a => `${a.symbol}@${a.chainKey}`), ['USDC@base'], 'never ETH, SOL, USDT or other tokens');
// $500 buy with $10 USDC on each of several networks: every network contributes.
const tens = {assets: ['base', 'bnb', 'solana', 'ethereum', 'arbitrum', 'robinhood'].map(chain => asset(chain, chain === 'robinhood' ? 'USDG' : 'USDC', 'cash', 10)), errors: []};
const order = buyPool(tens, token, 'So1').map(a => a.chainKey);
assert.equal(order.length, 6);
assert.equal(order[0], 'arbitrum', "the token's own network first");
assert.equal(order[1], 'solana', 'then Solana (home)');
assert.equal(order[order.length - 1], 'ethereum', 'Ethereum mainnet (dollar gas) last');
assert.ok(!buyPool(tens, token, undefined).some(a => a.chainKey === 'solana'), 'Solana only with a Solana wallet');
assert.deepEqual(spendOrder(tens.assets, 'solana').map(a => a.chainKey)[0], 'solana');
// A gas-free EVM leg needs Kivo's sponsorship; a Solana leg uses Kivo's fee payer.
assert.equal(legNeedsSponsorship({quote: {steps: [{items: [{data: {to: '0x1'}}]}]}}, 'base'), true);
assert.equal(legNeedsSponsorship({quote: {steps: [{items: [{data: {instructions: []}}]}]}}, 'base'), false);
assert.equal(legNeedsSponsorship({quote: {steps: []}}, 'solana'), false);

// --- Sweep home: USDC only, never coins ------------------------------------
const away = {assets: [asset('base', 'USDC', 'cash', 5.67), asset('base', 'ETH', 'native', 20), asset('bnb', 'USDT', 'stable', 9), asset('solana', 'USDC', 'cash', 2.3), asset('bnb', 'USDC', 'cash', 0.4)], errors: []};
assert.deepEqual(sweepCandidates(away).map(a => `${a.symbol}@${a.chainKey}`), ['USDC@base']);

// --- Fee-free sponsored move home ------------------------------------------
assert.deepEqual(homeMoveFlags('base', 'proof'), {homeMove: true, homeProof: 'proof'});
assert.deepEqual(homeMoveFlags('ethereum', 'proof'), {sweepHome: true}, 'Ethereum mainnet recovers its gas through the fee');

// The proof is the Solana key's signature over the server's message.
clearHomeProofs();
const seed = new Uint8Array(32).fill(5);
const solPub = bs58.encode(ed25519.getPublicKey(seed));
const secretKey = new Uint8Array(64); secretKey.set(seed); secretKey.set(ed25519.getPublicKey(seed), 32);
const evm = '0xAbCdEf0000000000000000000000000000000001';
const accounts = {evm: {address: evm, privateKey: ''}, solana: {address: solPub, privateKey: bs58.encode(secretKey)}};
const proof = homeProofFor(accounts);
assert.equal(homeMoveMessage(evm, solPub), `Kivo home: ${solPub} is the Solana wallet of ${evm.toLowerCase()}`, 'must match web/server/relay.ts homeMoveMessage');
assert.ok(ed25519.verify(bs58.decode(proof), new TextEncoder().encode(homeMoveMessage(evm, solPub)), bs58.decode(solPub)));
assert.equal(cachedHomeProof(evm, solPub), proof);
assert.throws(() => homeProofFor({...accounts, solana: {...accounts.solana, address: bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(6)))}}), /does not match/);

// The quote request: app fee 0, sponsorship asked for, flagged as a move home with its proof.
configureRelayEndpoints({quoteUrl: 'https://kivo.test/api/relay/quote', sponsorship: true});
let sentBody = null;
globalThis.fetch = async (_url, init) => { sentBody = JSON.parse(init.body); return new Response(JSON.stringify({message: 'stop'}), {status: 400}); };
await getRelayQuote({fromChainKey: 'base', toChainKey: 'solana', originCurrency: TOKEN_ADDRESSES.USDC.base, destinationCurrency: TOKEN_ADDRESSES.USDC.solana, amountBaseUnits: '5000000', userAddress: evm, recipientAddress: solPub, originAmountUsd: 5, ...homeMoveFlags('base', proof)}).catch(() => {});
assert.equal(sentBody.appFees[0].fee, '0', 'no app fee on a USDC move home');
assert.equal(sentBody.subsidizeFees, true);
assert.equal(sentBody.kivoHome, true);
assert.equal(sentBody.kivoHomeProof, proof);
assert.equal(sentBody.sponsoredFeeComponents, undefined, 'the server decides what a move home sponsors');
assert.equal(sentBody.recipient, solPub);

console.log('trade cash checks passed');
