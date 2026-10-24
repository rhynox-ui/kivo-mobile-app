// Automatic "move home": USDC (USDG) that lands on another network, from a
// deposit or a sell there, is moved to the user's USDC on Solana without the
// user doing anything, like a CEX balance. Each network is one Relay route
// straight to Solana USDC. Only cash moves: native coins (ETH, BNB, SOL…)
// and other tokens are the user's holdings and stay where they are.
// Costs: USDC->USDC has no Relay platform fee and Kivo charges no app fee;
// Kivo's server sponsors the gas after checking the move really is the
// user's own cash going to their own Solana wallet (homeProof). From
// Ethereum mainnet, where gas costs dollars, the move's fee recovers the gas.

import {parseUnits} from 'viem';
import {TOKEN_ADDRESSES} from '../core/chainData';
import {getRelayQuote} from '../core/relayQuote';
import {executeRelayQuote} from '../core/executeRelayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import {awayFromHome, HOME_CHAIN} from './home';
import {homeMoveFlags} from './convert';
import {homeProofFor} from './homeProof';
import type {SpendableAsset, SpendableBalance} from './spendable';

/** Below this the fixed route cost would eat too much of the move. */
export const MIN_SWEEP_USD = 1;

export type SweepResult = {movedUsd: number; moved: SpendableAsset[]; failed: {asset: SpendableAsset; error: string}[]};

/** The assets an automatic move would take home, largest first. */
export function sweepCandidates(balance: SpendableBalance): SpendableAsset[] {
  // Cash only, never the user's coins or tokens.
  return awayFromHome(balance).filter(asset => asset.kind === 'cash' && asset.chainKey !== HOME_CHAIN && asset.valueUsd >= MIN_SWEEP_USD && asset.chainKey !== 'near' as never);
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
  const proof = homeProofFor(accounts) ?? undefined;
  for (const asset of sweepCandidates(balance)) {
    if (onlyUpToUsd != null && result.movedUsd >= onlyUpToUsd) break;
    const params = {
      fromChainKey: asset.chainKey,
      toChainKey: HOME_CHAIN,
      originCurrency: asset.address,
      destinationCurrency: homeUsdc,
      amountBaseUnits: units(asset),
      userAddress: accounts.evm.address,
      recipientAddress: solana,
      originAmountUsd: asset.valueUsd,
      ...homeMoveFlags(asset.chainKey, proof),
      originGasOverhead: '80000',
    };
    try {
      const quote = await getRelayQuote(params);
      await executeRelayQuote(quote, accounts, undefined, {useGaslessTrading: true, requote: () => getRelayQuote(params)});
      result.movedUsd += asset.valueUsd;
      result.moved.push(asset);
    } catch (error) {
      result.failed.push({asset, error: error instanceof Error ? error.message : 'Move failed.'});
    }
  }
  return result;
}
