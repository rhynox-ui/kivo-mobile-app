// src/core/nearCashMoves.ts
//
// Moving cash (USDC) onto and off NEAR, for Convert — through NEAR
// Intents 1Click, the same way the site's Bridge does it, reusing this
// app's own 1Click client and safety checks (oneClick.ts: signed-quote
// verification + request echo; oneClickDeposits.ts: one payment per
// quote, saved before sending).
//
//   onto NEAR:  USDC on chain X → 1Click deposit address on X (a plain
//               USDC transfer, sent by sendUsdc with the normal gas
//               sponsorship) → USDC lands on the wallet's NEAR account.
//   off NEAR:   USDC on NEAR → ft_transfer to the 1Click deposit account,
//               signed by the wallet's NEAR key, gas paid by Mango's
//               relayer (nearSigning.ts) → USDC lands on chain X.
//
// Convert is fee-free in this app (Relay converts pass waiveAppFee), so
// these requests carry no Mango app fee either. Refunds always go back to
// the wallet's own account on the chain the money came from.

import {TOKEN_ADDRESSES, NEAR_USDC, NEAR_USDC_DECIMALS, assetDecimalsForChain, type ChainKey} from './chainData.ts';
import {ONE_CLICK_BLOCKCHAIN, type OneClickExpectation, type OneClickQuoteRequest, type OneClickToken} from './oneClick.ts';
import type {NearCall} from './nearSigning.ts';
import type {DerivedAccounts} from '../wallet/keys';

/** USDC → USDC across chains: 0.5% is plenty and keeps a bad quote from filling. */
export const NEAR_CASH_MOVE_SLIPPAGE_BPS = 50;
export const NEAR_CASH_MOVE_DEADLINE_MS = 60 * 60 * 1000;
const TGAS = 1_000_000_000_000n;
/** NEP-145 minimum when a token contract doesn't answer storage_balance_bounds (0.00125 NEAR, the usual value). */
const DEFAULT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

export type NearCashMoveDirection = 'to-near' | 'from-near';

/** Chains cash can move to/from NEAR on: a verified USDC address here AND a 1Click blockchain for it. */
export function nearCashMoveChains(): ChainKey[] {
  return (Object.keys(ONE_CLICK_BLOCKCHAIN) as ChainKey[]).filter(c => !!TOKEN_ADDRESSES.USDC?.[c]);
}

type ResolvedAsset = {assetId: string; decimals: number};

function resolveExact(tokens: OneClickToken[], blockchain: string, contract: string): ResolvedAsset | null {
  const t = tokens.find(x => x.blockchain === blockchain && typeof x.contractAddress === 'string' && x.contractAddress.toLowerCase() === contract.toLowerCase());
  return t ? {assetId: t.assetId, decimals: t.decimals} : null;
}

/** 1Click asset ids for USDC on NEAR and on `chainKey`, with decimals checked against this app's own. Throws when either is missing or disagrees. */
export function nearCashMoveAssets(tokens: OneClickToken[], chainKey: ChainKey): {near: ResolvedAsset; chain: ResolvedAsset} {
  const blockchain = ONE_CLICK_BLOCKCHAIN[chainKey];
  const contract = TOKEN_ADDRESSES.USDC?.[chainKey];
  if (!blockchain || !contract) throw new Error("NEAR Intents can't move USDC on this chain.");
  const near = resolveExact(tokens, 'near', NEAR_USDC);
  const chain = resolveExact(tokens, blockchain, contract);
  if (!near || !chain) throw new Error('NEAR Intents doesn\'t list USDC for this route right now.');
  if (near.decimals !== NEAR_USDC_DECIMALS || chain.decimals !== assetDecimalsForChain(chainKey, 'USDC')) {
    throw new Error("USDC decimals don't match NEAR Intents' listing, so this route is disabled for safety.");
  }
  return {near, chain};
}

function chainAddress(session: DerivedAccounts, chainKey: ChainKey): string {
  return chainKey === 'solana' ? session.solana.address : session.evm.address;
}

/**
 * The 1Click quote request for a cash move, and exactly what the signed
 * quote must echo back before anything is sent (assertOneClickQuoteSafeToFund).
 */
export function nearCashMoveRequest({
  direction,
  chainKey,
  amountBaseUnits,
  session,
  tokens,
  dry,
  now = Date.now(),
}: {
  direction: NearCashMoveDirection;
  chainKey: ChainKey;
  amountBaseUnits: string;
  session: DerivedAccounts;
  tokens: OneClickToken[];
  dry: boolean;
  now?: number;
}): {request: OneClickQuoteRequest; expected: Omit<OneClickExpectation, 'now'>} {
  if (!session.near) throw new Error('This wallet has no NEAR account.');
  if (!/^\d+$/.test(amountBaseUnits) || BigInt(amountBaseUnits) <= 0n) throw new Error('Enter an amount.');
  const {near, chain} = nearCashMoveAssets(tokens, chainKey);
  const toNear = direction === 'to-near';
  const request: OneClickQuoteRequest = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: NEAR_CASH_MOVE_SLIPPAGE_BPS,
    originAsset: toNear ? chain.assetId : near.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: toNear ? near.assetId : chain.assetId,
    amount: amountBaseUnits,
    refundTo: toNear ? chainAddress(session, chainKey) : session.near.address,
    refundType: 'ORIGIN_CHAIN',
    recipient: toNear ? session.near.address : chainAddress(session, chainKey),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + NEAR_CASH_MOVE_DEADLINE_MS).toISOString(),
    appFees: [],
  };
  return {
    request,
    expected: {
      originAsset: request.originAsset,
      destinationAsset: request.destinationAsset,
      amount: request.amount,
      recipient: request.recipient,
      recipientType: request.recipientType,
      refundTo: request.refundTo,
      maxSlippageBps: NEAR_CASH_MOVE_SLIPPAGE_BPS,
      appFees: [],
    },
  };
}

type View = <T = any>(contractId: string, method: string, args?: unknown) => Promise<T>;

/**
 * The NEAR side of "off NEAR": one call on NEAR's USDC contract —
 * [register the one-time deposit account if needed] + ft_transfer of
 * exactly `amountUnits` to it. The registration's NEAR comes from the
 * wallet's own account (Mango's relayer only pays gas).
 */
export async function nearUsdcDepositCall(depositAddress: string, amountUnits: bigint, view: View): Promise<NearCall> {
  if (amountUnits <= 0n) throw new Error('Nothing to send.');
  const registered = await view(NEAR_USDC, 'storage_balance_of', {account_id: depositAddress});
  const actions: NearCall['actions'] = [];
  if (!registered) {
    let min = DEFAULT_STORAGE_DEPOSIT;
    try {
      const bounds = await view<{min?: string}>(NEAR_USDC, 'storage_balance_bounds', {});
      if (bounds?.min && /^\d+$/.test(bounds.min)) min = BigInt(bounds.min);
    } catch {
      // keep the usual minimum
    }
    actions.push({type: 'FunctionCall', params: {methodName: 'storage_deposit', args: {account_id: depositAddress, registration_only: true}, gas: (10n * TGAS).toString(), deposit: min.toString()}});
  }
  actions.push({type: 'FunctionCall', params: {methodName: 'ft_transfer', args: {receiver_id: depositAddress, amount: amountUnits.toString()}, gas: (30n * TGAS).toString(), deposit: '1'}});
  return {receiverId: NEAR_USDC, actions};
}
