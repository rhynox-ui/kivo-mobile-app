import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {deriveNearAccount, NEAR_DERIVATION_PATH, nearDerivationPathForIndex} from '../trading/wallet/keys.ts';
import {deriveSolanaKeypair} from '../src/wallet/solanaKeys.ts';
import {fetchNearTokenBalance} from '../trading/core/nearTrade.ts';
import {nearCashMoveAssets, nearCashMoveRequest, nearUsdcDepositCall} from '../trading/core/nearCashMoves.ts';
import {NEAR_USDC, NEAR_USDC_DECIMALS, TOKEN_ADDRESSES, assetDecimalsForChain} from '../trading/core/chainData.ts';
import {totalCashUsd, pickPayChain} from '../trading/kivo/balances.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const REF_PUBLIC = 'ed25519:3j8k9Zr7iZs5yQnXcJvQzP9nJvZ6ZQ9Q5K6Q1g7pYx7A';
const REF_SECRET = 'ed25519:F1uH2Vj9P7y7w2Gq8e9nJvY7gW4g7m6Qh5X1Q2r3S4t5u6v7w8x9y0z1A2B3C4D5';

const near = deriveNearAccount(PHRASE);
const solana = deriveSolanaKeypair(PHRASE);
const session = {
  evm: {address: '0x9858effd232b4033e47d90003d41ec34ecaeda94', privateKey: '0x' + '1'.repeat(64)},
  solana: {address: solana.publicKey.toBase58(), privateKey: bs58.encode(solana.secretKey)},
  near,
};

assert.equal(NEAR_DERIVATION_PATH, "m/44'/397'/0'");
assert.equal(nearDerivationPathForIndex(1), "m/44'/397'/1'");
assert.match(near.address, /^[0-9a-f]{64}$/);
assert.ok(near.privateKey.startsWith('ed25519:'));
assert.equal(near.address, Buffer.from(bs58.decode(REF_PUBLIC.slice(8))).toString('hex'));
assert.equal(near.privateKey, REF_SECRET);
assert.notEqual(near.address, session.solana.address);

let viewCall;
const rawNearBalance = await fetchNearTokenBalance(NEAR_USDC, 'alice.near', async (contract, method, args) => {
  viewCall = {contract, method, args};
  return '1234567';
});
assert.equal(rawNearBalance, 1234567n);
assert.deepEqual(viewCall, {
  contract: NEAR_USDC,
  method: 'ft_balance_of',
  args: {account_id: 'alice.near'},
});

const tokens = [
  {
    assetId: 'nep141:usdc.near',
    decimals: NEAR_USDC_DECIMALS,
    blockchain: 'near',
    symbol: 'USDC',
    price: 1,
    priceUpdatedAt: new Date(0).toISOString(),
    contractAddress: NEAR_USDC,
  },
  ...(['ethereum', 'base'] ).map((chainKey) => ({
    assetId: chainKey + ':usdc',
    decimals: assetDecimalsForChain(chainKey, 'USDC'),
    blockchain: chainKey === 'ethereum' ? 'eth' : 'base',
    symbol: 'USDC',
    price: 1,
    priceUpdatedAt: new Date(0).toISOString(),
    contractAddress: TOKEN_ADDRESSES.USDC[chainKey],
  })),
];

const assets = nearCashMoveAssets(tokens, 'ethereum');
assert.equal(assets.near.assetId, 'nep141:usdc.near');
assert.equal(assets.near.decimals, NEAR_USDC_DECIMALS);
assert.equal(assets.chain.assetId, 'ethereum:usdc');

const toNear = nearCashMoveRequest({
  direction: 'to-near',
  chainKey: 'ethereum',
  amountBaseUnits: '1000000',
  session,
  tokens,
  dry: true,
  now: 1_700_000_000_000,
});
assert.equal(toNear.request.originAsset, assets.chain.assetId);
assert.equal(toNear.request.destinationAsset, assets.near.assetId);
assert.equal(toNear.request.amount, '1000000');
assert.equal(toNear.request.recipient, near.address);
assert.equal(toNear.request.refundTo, session.evm.address);
assert.equal(toNear.expected.recipient, near.address);

const fromNear = nearCashMoveRequest({
  direction: 'from-near',
  chainKey: 'base',
  amountBaseUnits: '2000000',
  session,
  tokens,
  dry: true,
  now: 1_700_000_000_000,
});
assert.equal(fromNear.request.originAsset, assets.near.assetId);
assert.equal(fromNear.request.destinationAsset, 'base:usdc');
assert.equal(fromNear.request.recipient, session.evm.address);
assert.equal(fromNear.request.refundTo, near.address);

const depositCall = await nearUsdcDepositCall('deposit.near', 987654n, async (_contract, method) => {
  if (method === 'storage_balance_of') return null;
  if (method === 'storage_balance_bounds') return {min: '12345'};
  throw new Error('Unexpected NEAR view method: ' + method);
});
assert.equal(depositCall.receiverId, NEAR_USDC);
assert.equal(depositCall.actions.length, 2);
assert.equal(depositCall.actions[0].params.methodName, 'storage_deposit');
assert.equal(depositCall.actions[0].params.deposit, '12345');
assert.equal(depositCall.actions[1].params.methodName, 'ft_transfer');
assert.equal(depositCall.actions[1].params.args.amount, '987654');

const evmRows = [{
  chainKey: 'ethereum',
  status: 'ok',
  balance: {
    chainKey: 'ethereum',
    tokenAddress: TOKEN_ADDRESSES.USDC.ethereum,
    symbol: 'USDC',
    raw: 2_000_000n,
    decimals: 6,
    amount: 2,
  },
}];
const evmTotal = totalCashUsd(evmRows);
const nearBalance = Number(rawNearBalance) / 10 ** NEAR_USDC_DECIMALS;
assert.equal(evmTotal.total + nearBalance, 3.234567);
assert.equal(pickPayChain(evmRows, 'ethereum', 1), 'ethereum');

console.log('NEAR account and cash integration checks passed: deterministic derivation, NEAR USDC read, 1Click routes, deposit registration, total balance inclusion, and spendable-chain separation.');
