// Convert on Kivo mobile: move any held asset to any supported asset on any
// network, like a bridge built into the wallet (SOL on Solana -> BNB on BNB
// Chain, ETH on Base -> USDC on Ethereum, USDC anywhere -> USDC anywhere).
// Every conversion is one Relay quote: the origin asset is spent on its own
// network and the target asset is delivered to the user's own address on the
// destination network. NEAR USDC keeps its separate NEAR Intents path
// (ConvertCashSheet), which only moves cash.
//
// Fees: a pure cash move (USDC/USDG -> USDC/USDG) stays free, exactly as
// before (moves to Base are sponsored as funding transfers). A conversion
// that changes asset is a swap and pays Kivo's normal fee (0.5%, max $50).

import {CHAIN_LABEL, MAINNET_CHAIN_IDS, type ChainKey} from '../core/chainData';
import type {getRelayQuote} from '../core/relayQuote';
import {CASH_CHAINS, cashAssetSymbol} from './balances';
import {nativeAsset, usdcAsset, verifiedAsset, type QuoteAsset} from './quote';
import type {SpendableAsset, SpendableKind} from './spendable';

type RelayQuoteParams = Parameters<typeof getRelayQuote>[0];

/** 'token': any other held token (a memecoin, WBTC…), converted like a sell into the target. */
export type ConvertAsset = QuoteAsset & {kind: SpendableKind | 'token'};

/** Networks whose own coin can be a conversion target (the same coins Search lists). */
export const CONVERT_NATIVE_CHAINS: ChainKey[] = (['solana', 'base', 'ethereum', 'bnb', 'arbitrum', 'avalanche', 'robinhood', 'unichain', 'ink'] as ChainKey[])
  .filter(chain => chain in MAINNET_CHAIN_IDS);

export function sameAsset(a: Pick<QuoteAsset, 'chainKey' | 'address'>, b: Pick<QuoteAsset, 'chainKey' | 'address'>): boolean {
  return a.chainKey === b.chainKey && (a.chainKey === 'solana' ? a.address === b.address : a.address.toLowerCase() === b.address.toLowerCase());
}

/** The cash coin on a network: USDC, or USDG on Robinhood. */
export function cashAsset(chainKey: ChainKey): ConvertAsset {
  const symbol = cashAssetSymbol(chainKey);
  return {...(symbol === 'USDC' ? usdcAsset(chainKey) : verifiedAsset(chainKey, symbol)), kind: 'cash'};
}

/** Every asset a conversion can deliver: cash on each cash network, then each network's own coin. */
export function convertTargets(options: {hasSolana: boolean}): ConvertAsset[] {
  const targets: ConvertAsset[] = [];
  for (const chainKey of CASH_CHAINS) {
    if (chainKey === 'solana' && !options.hasSolana) continue;
    try { targets.push(cashAsset(chainKey)); } catch { /* no verified contract on this network */ }
  }
  for (const chainKey of CONVERT_NATIVE_CHAINS) {
    if (chainKey === 'solana' && !options.hasSolana) continue;
    const asset = nativeAsset(chainKey);
    if (!targets.some(target => sameAsset(target, asset))) targets.push({...asset, kind: 'native'});
  }
  return targets;
}

export function convertAssetLabel(asset: Pick<QuoteAsset, 'chainKey' | 'symbol'>): string {
  return `${asset.symbol} · ${CHAIN_LABEL[asset.chainKey] ?? asset.chainKey}`;
}

/** Spendable assets worth listing as a source, largest first. */
export function convertSources(assets: SpendableAsset[]): SpendableAsset[] {
  return assets.filter(asset => asset.spendableAmount > 0 && asset.valueUsd >= 0.01).sort((a, b) => b.valueUsd - a.valueUsd);
}

/** A cash -> cash move keeps the old free behavior; anything else is a swap with Kivo's normal fee. */
export function isCashMove(from: Pick<ConvertAsset, 'kind'>, to: Pick<ConvertAsset, 'kind'>): boolean {
  return from.kind === 'cash' && to.kind === 'cash';
}

/** The Relay quote request for one conversion. */
export function convertQuoteParams(params: {
  from: ConvertAsset;
  to: ConvertAsset;
  amountBaseUnits: string;
  amountUsd: number | null;
  evmAddress: string;
  solanaAddress?: string;
}): RelayQuoteParams {
  const {from, to, amountBaseUnits, amountUsd, evmAddress, solanaAddress} = params;
  const user = from.chainKey === 'solana' ? solanaAddress : evmAddress;
  const recipient = to.chainKey === 'solana' ? solanaAddress : evmAddress;
  if (!user || !recipient) throw new Error('This wallet has no Solana address for this conversion.');
  const cashMove = isCashMove(from, to);
  return {
    fromChainKey: from.chainKey,
    toChainKey: to.chainKey,
    originCurrency: from.address,
    destinationCurrency: to.address,
    amountBaseUnits,
    userAddress: user,
    recipientAddress: recipient,
    originAmountUsd: amountUsd,
    // EVM/Calibur-only parameter; Solana-origin quotes must not carry it.
    ...(from.chainKey !== 'solana' ? {originGasOverhead: '80000'} : {}),
    ...(cashMove
      ? (to.chainKey === 'base' && from.chainKey !== 'solana' && from.symbol === 'USDC' ? {fundingTransfer: true} : {waiveAppFee: true})
      : {}),
  };
}
