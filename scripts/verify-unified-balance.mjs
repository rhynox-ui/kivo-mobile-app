// Checks the unified-balance buy rules (trading/kivo/spendable.ts, unified.ts):
// spend order, native reserves, leg sizing, never paying for a coin with
// itself, one fee per order, parallel-by-network execution and the spam filter.
import assert from 'node:assert/strict';
import {nativeSpendable, spendOrder, spendableFor, totalSpendableUsd} from '../trading/kivo/spendable.ts';
import {legUnits, runLegsByNetwork} from '../trading/kivo/unified.ts';
import {appFeeBps} from '../trading/core/fees.ts';
import {isNativeToken, marketAddressFor} from '../trading/kivo/tokens.ts';
import {looksLikeSpamToken} from '../trading/kivo/portfolio.ts';

const asset = (chainKey, symbol, kind, valueUsd, priceUsd = 1, address = `${chainKey}-${symbol}`) => ({chainKey, address, symbol, decimals: kind === 'native' ? 18 : 6, kind, amount: valueUsd / priceUsd, spendableAmount: valueUsd / priceUsd, priceUsd, valueUsd});

// The user's example: $2 Base, $3 BNB, $1 Solana, $4 Robinhood.
const balance = {assets: [
  asset('base', 'ETH', 'native', 2, 2000, '0x0000000000000000000000000000000000000000'),
  asset('bnb', 'USDC', 'cash', 3),
  asset('solana', 'SOL', 'native', 1, 150, '11111111111111111111111111111111'),
  asset('robinhood', 'USDG', 'cash', 4),
], errors: []};
assert.equal(totalSpendableUsd(balance), 10);

// Cash first (largest first), then native; the token's own network leads within a kind.
assert.deepEqual(spendOrder(balance.assets, 'arbitrum').map(a => a.chainKey), ['robinhood', 'bnb', 'base', 'solana']);
assert.deepEqual(spendOrder(balance.assets, 'bnb').map(a => a.chainKey), ['bnb', 'robinhood', 'base', 'solana']);

// Buying ETH on Base never spends ETH on Base.
const ethOnBase = {chainKey: 'base', tokenAddress: '0x0000000000000000000000000000000000000000'};
assert.equal(totalSpendableUsd(spendableFor(balance, ethOnBase)), 8);

// Native reserves: SOL keeps 0.003; Ethereum keeps $1; other EVM networks $0.05.
assert.ok(Math.abs(nativeSpendable('solana', 0.01, 150) - 0.007) < 1e-12);
assert.ok(Math.abs(nativeSpendable('ethereum', 0.001, 2000) - 0.0005) < 1e-12);
assert.ok(Math.abs(nativeSpendable('base', 0.001, 2000) - 0.000975) < 1e-12);
assert.equal(nativeSpendable('base', 0.00001, 2000), 0);

// Leg sizing never exceeds what may be spent.
const eth = balance.assets[0];
assert.equal(legUnits(eth, 1), '0.000500');
assert.ok(Number(legUnits(eth, 2)) <= eth.spendableAmount);
assert.equal(legUnits(balance.assets[1], 1.239), '1.239000');

// One fee per order: every leg uses the order's bps, so the legs' fees add up to the order fee.
const order = 10;
const bps = Number(appFeeBps(order));
const legFees = [4, 3, 2, 1].reduce((sum, leg) => sum + leg * bps / 10_000, 0);
assert.ok(Math.abs(legFees - Math.max(order * 0.005, 0.05)) < 1e-9);
// Before: each leg under $10 paid the $0.05 minimum on its own.
assert.ok([4, 3, 2, 1].reduce((sum, leg) => sum + leg * Number(appFeeBps(leg)) / 10_000, 0) > 0.19);

// Networks run in parallel, legs on one network one after another.
async function checkParallel() {
const events = [];
const legs = [{chainKey: 'base'}, {chainKey: 'bnb'}, {chainKey: 'base'}];
const settled = await runLegsByNetwork(legs, async (leg, index) => {
  events.push(`start ${index}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  events.push(`end ${index}`);
  if (index === 1) throw new Error('bnb failed');
  return index;
});
assert.deepEqual(events.slice(0, 2).sort(), ['start 0', 'start 1']);
assert.ok(events.indexOf('start 2') > events.indexOf('end 0'));
assert.deepEqual(settled.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
}

// Native coins trade by their placeholder; charts use the wrapped coin.
assert.ok(isNativeToken({chainKey: 'solana', tokenAddress: '11111111111111111111111111111111'}));
assert.ok(isNativeToken(ethOnBase));
assert.equal(marketAddressFor(ethOnBase), '0x4200000000000000000000000000000000000006');
assert.equal(marketAddressFor({chainKey: 'base', tokenAddress: '0xabc'}), '0xabc');

// Spam airdrops are recognized by what they advertise.
assert.ok(looksLikeSpamToken('$5000 USDC', 'Claim at usdc-gift.com'));
assert.ok(looksLikeSpamToken('ETH', 'Visit t.me/freeeth'));
assert.ok(!looksLikeSpamToken('BIO', 'Bio Protocol'));
assert.ok(!looksLikeSpamToken('PEPE', 'Pepe'));

checkParallel().then(() => console.log('unified balance checks passed'), error => { console.error(error); process.exit(1); });
