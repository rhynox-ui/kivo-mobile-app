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

const isHomeCash = (asset: SpendableAsset) => asset.chainKey === HOME_CHAIN && asset.kind === 'cash';

/** The part of a balance a trade may spend: Solana USDC only. */
export function onlyHomeCash(balance: SpendableBalance): SpendableBalance {
  return {assets: balance.assets.filter(isHomeCash), errors: balance.errors.filter(e => e.chainKey === HOME_CHAIN)};
}

/** Everything else the wallet holds that Convert can move home, in USD. */
export function awayFromHome(balance: SpendableBalance): SpendableAsset[] {
  return balance.assets.filter(asset => !isHomeCash(asset) && asset.valueUsd >= 0.5).sort((a, b) => b.valueUsd - a.valueUsd);
}
