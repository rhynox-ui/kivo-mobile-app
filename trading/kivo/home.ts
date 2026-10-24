// Kivo's home balance: USDC on Solana. Like FOMO's single cash balance,
// every buy is paid from it and every sell lands back in it, so a trade is
// one route instead of many small pieces from coins on several networks
// (each piece paid Relay's fixed cost again: ~6-8% lost on small buys).
// Funds elsewhere stay usable through Convert ("Move to Solana").

import type {ChainKey} from '../core/chainData';
import type {SpendableAsset, SpendableBalance} from './spendable';
import {usdcAsset, type QuoteAsset} from './quote';

export const HOME_CHAIN: ChainKey = 'solana';

/** The home cash asset: USDC on Solana. */
export function homeCashAsset(): QuoteAsset {
  return usdcAsset(HOME_CHAIN);
}

// Trade cash is strictly USDC (and USDG where Kivo treats it as equivalent cash).
// Long-term SOL, ETH, USDT, and other holdings are never auto-converted to fund a buy.
const isUsdcCash = (asset: SpendableAsset) => asset.kind === 'cash' && ['USDC', 'USDG'].includes(asset.symbol.toUpperCase());
const isHomeCash = (asset: SpendableAsset) => asset.chainKey === HOME_CHAIN && isUsdcCash(asset);

/** The part of a balance a trade may spend: USDC cash on Solana only. */
export function onlyHomeCash(balance: SpendableBalance): SpendableBalance {
  return {assets: balance.assets.filter(isHomeCash), errors: balance.errors.filter(e => e.chainKey === HOME_CHAIN && ['USDC', 'USDG'].includes(e.symbol.toUpperCase()))};
}

/** USDC cash held on other supported networks, available to move to Solana. */
export function awayFromHome(balance: SpendableBalance): SpendableAsset[] {
  return balance.assets.filter(asset => isUsdcCash(asset) && !isHomeCash(asset) && asset.valueUsd >= 0.5).sort((a, b) => b.valueUsd - a.valueUsd);
}

/** Restrict the Trade section's total to USDC cash across supported networks. */
export function usdcOnly(balance: SpendableBalance): SpendableBalance {
  return {...balance, assets: balance.assets.filter(isUsdcCash), errors: balance.errors.filter(e => ['USDC', 'USDG'].includes(e.symbol.toUpperCase()))};
}
