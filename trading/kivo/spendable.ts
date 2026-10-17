// Everything Kivo mobile can spend on a buy, across every network: USDC/USDG
// cash, other verified dollar coins (USDT, USDT0) and each network's own coin
// (ETH, BNB, SOL, …). Like FOMO, the user sees one balance in dollars and
// never has to move funds first; planUnifiedBuy (unified.ts) splits a buy
// into one leg per asset and every leg routes straight to the token bought.
//
// Kivo holds the keys on this device, so it can sign on every network in one
// confirmation. Rules:
//   - cash first, then other dollar coins, then native coins, so a buy only
//     sells ETH/BNB/SOL when the user's dollars don't cover it;
//   - native coins keep a small reserve so the wallet is never emptied to the
//     last wei (Solana accounts must also stay rent-exempt);
//   - a native coin with no live price is left out, never valued by a guess;
//   - investment tokens the user bought (memecoins, WBTC) are never sold to
//     pay for another buy.
// Every value here is only for planning: each leg is re-quoted by Relay,
// which prices the real input, and the intent firewall checks every leg.

import {CHAIN_LABEL, TOKEN_ADDRESSES, assetDecimalsForChain, currencyAddress, type ChainKey} from '../core/chainData';
import {fetchWalletPrices} from '../core/walletPrices';
import {CASH_CHAINS, fetchCashBalances, readNativeBalance, readSolanaNativeBalance, readTokenBalance, spendableCash} from './balances';
import {EVM_TRADE_CHAINS, nativeSymbol} from './tokens';

export type SpendableKind = 'cash' | 'stable' | 'native';

export type SpendableAsset = {
  chainKey: ChainKey;
  address: string;
  symbol: string;
  decimals: number;
  kind: SpendableKind;
  /** Whole balance, in token units. */
  amount: number;
  /** Units that may be spent (balance minus any gas/rent reserve). */
  spendableAmount: number;
  priceUsd: number;
  /** spendableAmount in USD. */
  valueUsd: number;
};

export type SpendableBalance = {
  assets: SpendableAsset[];
  /** Networks or assets that could not be read (shown, never counted as zero). */
  errors: {chainKey: ChainKey; symbol: string; error: string}[];
};

/** Dollar coins counted at $1 (Relay prices the real input on every quote). */
const STABLE_SYMBOLS = ['USDT', 'USDT0'] as const;
/** Networks whose native coin is already a dollar coin read above (Arc: USDC, Stable: USDT0). */
const NATIVE_IS_STABLE = new Set<ChainKey>(['arc', 'stable']);
/** Native coin kept back, in USD, so the wallet is never emptied. Ethereum gas costs more. */
const NATIVE_RESERVE_USD: Partial<Record<ChainKey, number>> = {ethereum: 1};
const DEFAULT_NATIVE_RESERVE_USD = 0.05;
/** SOL kept back: rent-exempt minimum for the wallet plus room for a token account. */
const SOLANA_RESERVE_SOL = 0.003;
const CACHE_TTL_MS = 30_000;

let cache: {key: string; value: SpendableBalance; at: number} | null = null;
let inFlight: {key: string; promise: Promise<SpendableBalance>} | null = null;

export function clearSpendableBalanceCache(): void {
  cache = null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Balance unavailable.';
}

/** Units that may be spent from a native balance worth `price` each. */
export function nativeSpendable(chainKey: ChainKey, amount: number, price: number): number {
  const reserve = chainKey === 'solana' ? SOLANA_RESERVE_SOL : (NATIVE_RESERVE_USD[chainKey] ?? DEFAULT_NATIVE_RESERVE_USD) / price;
  return Math.max(0, amount - reserve);
}

async function read(owner: string, solanaOwner: string | undefined, forceFresh: boolean): Promise<SpendableBalance> {
  const assets: SpendableAsset[] = [];
  const errors: SpendableBalance['errors'] = [];
  const evmChains = EVM_TRADE_CHAINS;

  const stableReads = evmChains.flatMap(chainKey => STABLE_SYMBOLS.flatMap(symbol => {
    const address = TOKEN_ADDRESSES[symbol]?.[chainKey];
    return address ? [{chainKey, symbol, address, decimals: assetDecimalsForChain(chainKey, symbol) ?? 6}] : [];
  }));
  const nativeChains: ChainKey[] = [...evmChains.filter(chainKey => !NATIVE_IS_STABLE.has(chainKey)), ...(solanaOwner ? ['solana' as ChainKey] : [])];

  const [cashRows, prices, stables, natives] = await Promise.all([
    fetchCashBalances(owner, CASH_CHAINS, solanaOwner, {forceFresh}),
    fetchWalletPrices().catch(() => ({} as Record<string, number>)),
    Promise.allSettled(stableReads.map(item => readTokenBalance(item.chainKey, item.address, owner, item.symbol, item.decimals))),
    Promise.allSettled(nativeChains.map(chainKey => chainKey === 'solana' ? readSolanaNativeBalance(solanaOwner!, {forceFresh}) : readNativeBalance(chainKey, owner, {forceFresh}))),
  ]);

  for (const row of cashRows) {
    if (row.status === 'error') { errors.push({chainKey: row.chainKey, symbol: row.chainKey === 'robinhood' ? 'USDG' : 'USDC', error: row.error}); continue; }
    const spendable = spendableCash(row.chainKey, row.balance.amount);
    if (row.balance.amount > 0) assets.push({chainKey: row.chainKey, address: row.balance.tokenAddress, symbol: row.balance.symbol, decimals: row.balance.decimals, kind: 'cash', amount: row.balance.amount, spendableAmount: spendable, priceUsd: 1, valueUsd: spendable});
  }
  stables.forEach((outcome, index) => {
    const item = stableReads[index];
    if (outcome.status === 'rejected') { errors.push({chainKey: item.chainKey, symbol: item.symbol, error: message(outcome.reason)}); return; }
    const amount = outcome.value.amount;
    if (amount > 0) assets.push({chainKey: item.chainKey, address: item.address, symbol: item.symbol, decimals: outcome.value.decimals, kind: 'stable', amount, spendableAmount: amount, priceUsd: 1, valueUsd: amount});
  });
  natives.forEach((outcome, index) => {
    const chainKey = nativeChains[index];
    const symbol = nativeSymbol(chainKey);
    if (outcome.status === 'rejected') { errors.push({chainKey, symbol, error: message(outcome.reason)}); return; }
    const price = prices[symbol];
    const amount = outcome.value.amount;
    if (!(amount > 0) || !(price > 0)) return;
    const spendable = nativeSpendable(chainKey, amount, price);
    if (spendable > 0) assets.push({chainKey, address: currencyAddress(chainKey, symbol), symbol, decimals: assetDecimalsForChain(chainKey, symbol) ?? outcome.value.decimals, kind: 'native', amount, spendableAmount: spendable, priceUsd: price, valueUsd: spendable * price});
  });
  return {assets, errors};
}

/** Every spendable asset on every network. Each read fails on its own; cached briefly. */
export async function fetchSpendableBalance(owner: string, solanaOwner?: string, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<SpendableBalance> {
  const key = `${owner.toLowerCase()}:${solanaOwner ?? ''}`;
  if (!forceFresh && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!forceFresh && inFlight?.key === key) return inFlight.promise;
  const promise = read(owner, solanaOwner, forceFresh).then(value => {
    cache = {key, value, at: Date.now()};
    return value;
  });
  inFlight = {key, promise};
  try { return await promise; }
  finally { if (inFlight?.promise === promise) inFlight = null; }
}

const KIND_ORDER: Record<SpendableKind, number> = {cash: 0, stable: 1, native: 2};

/**
 * The order a buy draws from: cash, then dollar coins, then native coins;
 * within each, the token's own network first, then the largest balance.
 */
export function spendOrder(assets: SpendableAsset[], tokenChain: ChainKey): SpendableAsset[] {
  return [...assets].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.chainKey === tokenChain ? 0 : 1) - (b.chainKey === tokenChain ? 0 : 1)
    || b.valueUsd - a.valueUsd);
}

export function totalSpendableUsd(balance: SpendableBalance | null): number {
  return balance ? balance.assets.reduce((sum, asset) => sum + asset.valueUsd, 0) : 0;
}

export function assetLabel(asset: Pick<SpendableAsset, 'chainKey' | 'symbol'>): string {
  return `${asset.symbol} on ${CHAIN_LABEL[asset.chainKey] ?? asset.chainKey}`;
}

/** The balance without the coin being bought (buying ETH on Base never spends ETH on Base). */
export function spendableFor(balance: SpendableBalance, token: {chainKey: string; tokenAddress: string}): SpendableBalance {
  const same = (asset: SpendableAsset) => asset.chainKey === token.chainKey && (asset.chainKey === 'solana' ? asset.address === token.tokenAddress : asset.address.toLowerCase() === token.tokenAddress.toLowerCase());
  return {...balance, assets: balance.assets.filter(asset => !same(asset))};
}
