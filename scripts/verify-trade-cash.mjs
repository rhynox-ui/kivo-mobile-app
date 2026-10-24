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
import {convertGasPath, homeMoveFlags, quoteGasUsd} from '../trading/kivo/convert.ts';
import {MIN_ETHEREUM_SWEEP_USD} from '../trading/kivo/sweep.ts';
import {OWN_GAS_TRANSFER_CHAINS} from '../trading/kivo/cash.ts';
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

// --- Ethereum mainnet: Kivo recovers its gas, funds are never stuck ---------
// Auto-sweep only from $50 (gas is then a small share); below that it stays on Ethereum and is still spent by buys, last.
assert.equal(MIN_ETHEREUM_SWEEP_USD, 50);
const ethSmall = {assets: [asset('ethereum', 'USDC', 'cash', 30), asset('base', 'USDC', 'cash', 2)], errors: []};
assert.deepEqual(sweepCandidates(ethSmall).map(a => a.chainKey), ['base']);
assert.deepEqual(sweepCandidates({assets: [asset('ethereum', 'USDC', 'cash', 60)], errors: []}).map(a => a.chainKey), ['ethereum']);
assert.equal(buyPool(ethSmall, token, 'So1').at(-1).chainKey, 'ethereum', 'small Ethereum USDC is still spendable, as the last source');
// A move from Ethereum carries a fee the server raises to cover the gas (never fee-free).
assert.deepEqual(homeMoveFlags('ethereum'), {sweepHome: true});
// Convert decides how the network fee is paid, always with a way forward.
let path = convertGasPath({fromChain: 'ethereum', fromKind: 'cash', sponsorship: 'on: fee raised to 4.00% to cover network gas', appFeeUsd: 2.4});
assert.equal(path.mode, 'sponsored');
assert.match(path.note, /repaid in this move's fee: \$2\.40/, 'the Ethereum fee is shown before confirming');
path = convertGasPath({fromChain: 'ethereum', fromKind: 'cash', sponsorship: 'dropped: sponsoring $2.0000 would exceed the $0.0020 fee', userFeeSponsorship: 'on: fee raised to 12.50% to cover network gas', userFeeUsd: 2.5});
assert.equal(path.mode, 'user-fee', '5% not enough: the user is shown the cost and confirms paying it');
assert.match(path.note, /\$2\.50.*Confirm/);
path = convertGasPath({fromChain: 'ethereum', fromKind: 'cash', sponsorship: 'dropped: x', userFeeSponsorship: 'dropped: sponsoring $2.0000 would exceed', gasUsd: 2, hasNativeGas: true});
assert.equal(path.mode, 'own-gas', 'gas above half the amount: paid with the wallet\'s own ETH');
path = convertGasPath({fromChain: 'ethereum', fromKind: 'cash', sponsorship: 'dropped: x', userFeeSponsorship: 'dropped: y', gasUsd: 2, hasNativeGas: false});
assert.equal(path.mode, 'needs-gas');
assert.match(path.note, /larger amount|gas coin/);
assert.equal(convertGasPath({fromChain: 'base', fromKind: 'cash', sponsorship: 'on: fee-free move home'}).note, null);
assert.equal(convertGasPath({fromChain: 'base', fromKind: 'cash', sponsorship: 'off: the Solana recipient…', awaitingProof: true}).mode, 'sponsored', 're-quoted with the proof at confirmation');
assert.equal(quoteGasUsd('dropped: sponsoring $2.0000 would exceed the $0.0020 fee', null), 2);
// Transfers on Ethereum are never sponsored by Kivo: the wallet's own ETH pays (never a dead end).
assert.ok(OWN_GAS_TRANSFER_CHAINS.has('ethereum'));

// A confirmed user-paid gas fee: sponsored, never the free cash-move flags.
sentBody = null;
await getRelayQuote({fromChainKey: 'ethereum', toChainKey: 'solana', originCurrency: TOKEN_ADDRESSES.USDC.ethereum, destinationCurrency: TOKEN_ADDRESSES.USDC.solana, amountBaseUnits: '20000000', userAddress: evm, recipientAddress: solPub, originAmountUsd: 20, ...homeMoveFlags('ethereum'), userPaysGas: true}).catch(() => {});
assert.equal(sentBody.kivoUserPaysGas, true);
assert.equal(sentBody.subsidizeFees, true);
assert.equal(sentBody.appFees[0].fee, '10', 'a cash move pays only the gas the server sizes, no Kivo margin on top');
assert.equal(sentBody.kivoHome, undefined);
sentBody = null;
await getRelayQuote({fromChainKey: 'base', toChainKey: 'solana', originCurrency: TOKEN_ADDRESSES.USDC.base, destinationCurrency: TOKEN_ADDRESSES.USDC.solana, amountBaseUnits: '5000000', userAddress: evm, recipientAddress: solPub, originAmountUsd: 5, ...homeMoveFlags('base', proof), userPaysGas: true}).catch(() => {});
assert.equal(sentBody.kivoHome, undefined, 'userPaysGas replaces the free move-home path');

console.log('trade cash checks passed');
