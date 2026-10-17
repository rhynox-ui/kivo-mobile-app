// Automatic "move home": funds that land on another network or in another
// coin (USDC on Base, ETH, BNB, SOL…) are moved to the user's USDC on Solana
// without the user doing anything, like a CEX balance. Each asset is one
// Relay route straight to Solana USDC. Costs: USDC->USDC has no Relay
// platform fee; Kivo sponsors the gas and, if that costs more than the
// tiny app fee carried, the server raises that move's fee just enough to
// recover it. Native coins pay their own gas from the reserve kept on them.

import {parseUnits} from 'viem';
import {TOKEN_ADDRESSES} from '../core/chainData';
import {getRelayQuote} from '../core/relayQuote';
import {executeRelayQuote} from '../core/executeRelayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import {awayFromHome, HOME_CHAIN} from './home';
import type {SpendableAsset, SpendableBalance} from './spendable';

/** Below this the fixed route cost would eat too much of the move. */
export const MIN_SWEEP_USD = 1;

export type SweepResult = {movedUsd: number; moved: SpendableAsset[]; failed: {asset: SpendableAsset; error: string}[]};

/** The assets an automatic move would take home, largest first. */
export function sweepCandidates(balance: SpendableBalance): SpendableAsset[] {
  // SOL on Solana stays as SOL: it is the home network's own gas coin, and
  // selling it would only cost a route fee for no benefit.
  return awayFromHome(balance).filter(asset => asset.valueUsd >= MIN_SWEEP_USD && asset.chainKey !== 'near' as never && !(asset.chainKey === HOME_CHAIN && asset.kind === 'native'));
}

function units(asset: SpendableAsset): string {
  return parseUnits(asset.spendableAmount.toFixed(Math.min(asset.decimals, 9)), asset.decimals).toString();
}

/** Moves every candidate to USDC on Solana, one at a time. Each move fails on its own. */
export async function sweepToHome({balance, accounts, onlyUpToUsd}: {balance: SpendableBalance; accounts: DerivedAccounts; onlyUpToUsd?: number}): Promise<SweepResult> {
  const solana = accounts.solana?.address;
  const homeUsdc = TOKEN_ADDRESSES.USDC?.[HOME_CHAIN];
  const result: SweepResult = {movedUsd: 0, moved: [], failed: []};
  if (!solana || !homeUsdc) return result;
  for (const asset of sweepCandidates(balance)) {
    if (onlyUpToUsd != null && result.movedUsd >= onlyUpToUsd) break;
    const evmGasless = asset.chainKey !== 'solana' && asset.kind !== 'native';
    const params = {
      fromChainKey: asset.chainKey,
      toChainKey: HOME_CHAIN,
      originCurrency: asset.address,
      destinationCurrency: homeUsdc,
      amountBaseUnits: units(asset),
      userAddress: asset.chainKey === 'solana' ? solana : accounts.evm.address,
      recipientAddress: solana,
      originAmountUsd: asset.valueUsd,
      sweepHome: true,
      ...(evmGasless ? {originGasOverhead: '80000'} : {}),
    };
    try {
      const quote = await getRelayQuote(params);
      await executeRelayQuote(quote, accounts, undefined, {useGaslessTrading: evmGasless, requote: () => getRelayQuote(params)});
      result.movedUsd += asset.valueUsd;
      result.moved.push(asset);
    } catch (error) {
      result.failed.push({asset, error: error instanceof Error ? error.message : 'Move failed.'});
    }
  }
  return result;
}
