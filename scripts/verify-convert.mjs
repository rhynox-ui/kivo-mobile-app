// Checks Convert's rules (trading/kivo/convert.ts): targets, sources, fees and
// who signs/receives. Run: node --experimental-strip-types --import ./scripts/ts-extensionless.mjs scripts/verify-convert.mjs
import assert from 'node:assert/strict';
import {cashAsset, convertQuoteParams, convertSources, convertTargets, isCashMove, sameAsset} from '../trading/kivo/convert.ts';

const evm = '0x0000000000000000000000000000000000000001';
const sol = 'So1anaWa11et1111111111111111111111111111111';

// Targets: cash on every cash network plus native coins; Solana only with a Solana wallet.
const withSol = convertTargets({hasSolana: true});
const withoutSol = convertTargets({hasSolana: false});
assert.ok(withSol.some(t => t.chainKey === 'solana' && t.symbol === 'SOL'));
assert.ok(withSol.some(t => t.chainKey === 'bnb' && t.symbol === 'BNB' && t.kind === 'native'));
assert.ok(withSol.some(t => t.chainKey === 'robinhood' && t.symbol === 'USDG' && t.kind === 'cash'));
assert.ok(!withoutSol.some(t => t.chainKey === 'solana'));
assert.equal(new Set(withSol.map(t => `${t.chainKey}:${t.address.toLowerCase()}`)).size, withSol.length, 'no duplicate targets');

// Sources: zero balances hidden, largest first.
const src = convertSources([
  {chainKey: 'base', address: '0x0', symbol: 'ETH', decimals: 18, kind: 'native', amount: 0.001, spendableAmount: 0.0009, priceUsd: 2000, valueUsd: 1.8},
  {chainKey: 'bnb', address: '0x1', symbol: 'USDC', decimals: 18, kind: 'cash', amount: 3, spendableAmount: 3, priceUsd: 1, valueUsd: 3},
  {chainKey: 'ink', address: '0x2', symbol: 'USDT0', decimals: 6, kind: 'stable', amount: 0, spendableAmount: 0, priceUsd: 1, valueUsd: 0},
]);
assert.deepEqual(src.map(a => a.symbol), ['USDC', 'ETH']);

// Fees: cash -> cash stays free (funding transfer to Base); any swap pays the normal fee.
const solNative = withSol.find(t => t.chainKey === 'solana' && t.kind === 'native');
const bnbNative = withSol.find(t => t.chainKey === 'bnb' && t.kind === 'native');
const toBase = convertQuoteParams({from: cashAsset('ethereum'), to: cashAsset('base'), amountBaseUnits: '1000000', amountUsd: 1, evmAddress: evm});
assert.equal(toBase.fundingTransfer, true);
const cashToSol = convertQuoteParams({from: cashAsset('base'), to: cashAsset('solana'), amountBaseUnits: '1000000', amountUsd: 1, evmAddress: evm, solanaAddress: sol});
assert.equal(cashToSol.waiveAppFee, true);
assert.equal(cashToSol.recipientAddress, sol);
const swap = convertQuoteParams({from: solNative, to: bnbNative, amountBaseUnits: '10000000', amountUsd: 1.5, evmAddress: evm, solanaAddress: sol});
assert.equal(swap.waiveAppFee, undefined);
assert.equal(swap.fundingTransfer, undefined);
assert.equal(swap.userAddress, sol, 'Solana origin signs with the Solana wallet');
assert.equal(swap.recipientAddress, evm, 'BNB is delivered to the EVM address');
assert.equal(swap.originGasOverhead, undefined, 'no Calibur overhead on Solana origin');
assert.ok(!isCashMove(solNative, cashAsset('base')));
assert.throws(() => convertQuoteParams({from: cashAsset('base'), to: solNative, amountBaseUnits: '1', amountUsd: 1, evmAddress: evm}));
assert.ok(sameAsset({chainKey: 'base', address: '0xAbC'}, {chainKey: 'base', address: '0xabc'}));

console.log('convert checks passed');
