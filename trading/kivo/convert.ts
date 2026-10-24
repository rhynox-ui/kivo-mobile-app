// Convert on Kivo mobile: move any held asset to any supported asset on any
// network, like a bridge built into the wallet (SOL on Solana -> BNB on BNB
// Chain, ETH on Base -> USDC on Ethereum, USDC anywhere -> USDC anywhere).
// Every conversion is one Relay quote: the origin asset is spent on its own
// network and the target asset is delivered to the user's own address on the
// destination network. NEAR USDC keeps its separate NEAR Intents path
// (ConvertCashSheet), which only moves cash.
//
// Fees: a pure cash move (USDC/USDG -> USDC/USDG) stays free (moves to Base
// are sponsored as funding transfers, moves home to Solana as fee-free home
// moves, except from Ethereum mainnet where the fee recovers the gas). A conversion
// that changes asset is a swap and pays Kivo's normal fee (fees.ts kivoFeeUsd, max $50).

import {CHAIN_LABEL, MAINNET_CHAIN_IDS, type ChainKey} from '../core/chainData';
import type {getRelayQuote} from '../core/relayQuote';
import {CASH_CHAINS, cashAssetSymbol} from './balances';
import {nativeAsset, usdcAsset, verifiedAsset, type QuoteAsset} from './quote';
import type {SpendableAsset, SpendableKind} from './spendable';
import {cachedHomeProof} from './homeProof';

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

/** Where gas costs dollars, a move home is not fee-free: it pays its own gas through the fee (server homeMoveCap). */
export const HOME_MOVE_FEE_CHAINS = new Set<ChainKey>(['ethereum']);

/**
 * Quote flags for moving the user's own cash (USDC/USDG) on an EVM network to
 * their USDC on Solana: a fee-free sponsored move home (with the Solana
 * wallet's proof when one was signed this session), or on Ethereum mainnet
 * the fee-carrying sweep whose fee only recovers the gas Kivo pays.
 */
export function homeMoveFlags(fromChain: ChainKey, homeProof?: string): Pick<RelayQuoteParams, 'homeMove' | 'homeProof' | 'sweepHome'> {
  if (HOME_MOVE_FEE_CHAINS.has(fromChain)) return {sweepHome: true};
  return {homeMove: true, ...(homeProof ? {homeProof} : {})};
}

export type ConvertGasPath = {
  /** sponsored: Kivo pays (on Ethereum repaid in the fee); user-fee: the user confirmed paying the gas from the amount; own-gas: the wallet pays gas in its own coin. */
  mode: 'sponsored' | 'user-fee' | 'own-gas' | 'needs-gas';
  /** Shown before confirming; null when there is nothing to say. */
  note: string | null;
};

const usdText = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * How a conversion starting on an EVM network pays its network fee. Owner
 * rule: never trap funds, never a dead end, and Kivo recovers its gas.
 *   1. Kivo's server sponsored the quote ("on…"): gas-free (on Ethereum
 *      mainnet the move's fee repays the gas, shown before confirming).
 *   2. Otherwise, re-quoted with the user paying the gas from the amount
 *      (userPaysGas) and sponsored that way: the cost is shown and the user
 *      confirms it.
 *   3. Otherwise (gas above half the amount), the wallet pays gas in its own
 *      coin when it holds some; only with none is it "needs-gas".
 * Solana and native-coin origins pay their own way and are always 'sponsored'
 * here (nothing to decide). `awaitingProof`: a fee-free move home quoted
 * before its Solana proof; it is re-quoted with the proof at confirmation.
 */
export function convertGasPath(params: {fromChain: ChainKey; fromKind: ConvertAsset['kind']; sponsorship: string | null; userFeeSponsorship?: string | null; userFeeUsd?: number | null; appFeeUsd?: number | null; gasUsd?: number | null; hasNativeGas?: boolean; awaitingProof?: boolean}): ConvertGasPath {
  const {fromChain, fromKind, sponsorship, userFeeSponsorship, userFeeUsd, appFeeUsd, gasUsd, hasNativeGas, awaitingProof} = params;
  const label = CHAIN_LABEL[fromChain] ?? fromChain;
  if (fromChain === 'solana' || fromKind === 'native' || awaitingProof) return {mode: 'sponsored', note: null};
  if ((sponsorship ?? '').startsWith('on')) {
    return {mode: 'sponsored', note: HOME_MOVE_FEE_CHAINS.has(fromChain) ? `${label} gas is paid by Kivo and repaid in this move's fee${appFeeUsd != null ? `: ${usdText(appFeeUsd)}` : ''}.` : null};
  }
  if ((userFeeSponsorship ?? '').startsWith('on')) {
    return {mode: 'user-fee', note: `Kivo can't cover the ${label} network fee for free on this amount. It costs ${userFeeUsd != null ? usdText(userFeeUsd) : 'the fee shown'}, taken from the amount. Confirm to pay it.`};
  }
  const gas = gasUsd != null && gasUsd > 0 ? ` (about ${usdText(gasUsd)})` : '';
  if (hasNativeGas) return {mode: 'own-gas', note: `The ${label} network fee${gas} is more than half this amount, so it is paid with your ${label} gas coin. Confirm to pay it.`};
  return {mode: 'needs-gas', note: `The ${label} network fee${gas} is more than half this amount. Convert a larger amount, or add a little gas coin on ${label} to pay it yourself.`};
}

/** Kivo's app fee in a Relay quote, USD (null when Relay does not report it). */
export function quoteAppFeeUsd(quote: {fees?: {app?: {amountUsd?: string | number}}} | null | undefined): number | null {
  const n = Number(quote?.fees?.app?.amountUsd);
  return Number.isFinite(n) ? n : null;
}

/** USD Kivo would sponsor for a quote as Relay priced it (the gas), from "sponsoring $X" or the quote's gas fee. */
export function quoteGasUsd(sponsorship: string | null, quote: {fees?: {gas?: {amountUsd?: string | number}}} | null | undefined): number | null {
  const fromHeader = sponsorship?.match(/sponsoring \$([0-9.]+)/);
  if (fromHeader) return Number(fromHeader[1]);
  const n = Number(quote?.fees?.gas?.amountUsd);
  return Number.isFinite(n) && n > 0 ? n : null;
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
      ? to.chainKey === 'base' && from.chainKey !== 'solana' && from.symbol === 'USDC'
        // Existing Base funding-transfer path: Kivo sponsors this move without
        // charging an app fee, and the backend records the quote for /execute.
        ? {fundingTransfer: true}
        // Solana is Kivo Mobile's home network: an EVM-origin cash move home
        // is fee-free yet sponsored and recorded for /execute (homeMoveFlags).
        : to.chainKey === 'solana' && from.chainKey !== 'solana'
          ? homeMoveFlags(from.chainKey, cachedHomeProof(evmAddress, solanaAddress))
          : {waiveAppFee: true}
      : {}),
  };
}
