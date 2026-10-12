// src/core/oneClickDeposits.ts
//
// Funding a 1Click quote and following it to completion. Pure logic with
// its side effects passed in (send, store, submit, status fetch), so the
// money-moving rules below are testable offline in
// scripts/verify-one-click-deposits.mjs; the React Native storage adapter
// lives in src/wallet/oneClickSwapStore.ts.
//
// The order of operations is the safety design:
//
//   1. Firewall. assertOneClickQuoteSafeToFund (oneClick.ts) — signature,
//      request echo, fees, memo, deadline margin.
//   2. One deposit per address. A record that already has a deposit tx
//      refuses a second send, so a double tap or a retry after a slow
//      network can't pay the same quote twice.
//   3. Persist BEFORE sending. The full signed quote is written to the
//      store first: 1Click's own docs say it must be kept "in order to
//      resolve any disputes or mistakes", and if the app dies mid-send
//      the swap can still be found and tracked on the next launch.
//   4. Deadline re-check immediately before broadcasting — the user may
//      have sat on the confirm screen since the quote arrived.
//   5. Send exactly quote.amountIn (EXACT_INPUT). Less is refunded at the
//      deadline; more is swapped and the excess refunded — neither is
//      what the user confirmed.
//   6. Tell 1Click about the tx (best effort; it also watches the chain).
//
// A send that throws is recorded as SEND_FAILED, not deleted: a timeout
// can happen after the transaction was already broadcast, so the record
// keeps being polled until the deposit deadline has clearly passed.

import {formatUnits} from 'viem';
import type {ChainKey} from './chainData';
import {
  assertOneClickDepositWindowOpen,
  assertOneClickQuoteSafeToFund,
  isOneClickStatusFinal,
  type OneClickExpectation,
  type OneClickQuoteResponse,
  type OneClickStatus,
  type OneClickStatusResponse,
} from './oneClick.ts';

export type OneClickSwapStatus = OneClickStatus | 'SENDING' | 'SEND_FAILED';

export type OneClickSwapRecord = {
  depositAddress: string;
  /** The full signed quote, exactly as 1Click returned it — kept for disputes. */
  quoteResponse: OneClickQuoteResponse;
  /** Where the money was sent from — a Relay chain, or 'near' for cash moved off NEAR. */
  originChainKey: ChainKey | 'near';
  originSymbol: string;
  /** Human-readable amount sent, e.g. "25.5". */
  payAmount: string;
  fromAddress: string;
  depositTxHash: string | null;
  /** True from the moment send() is called — a send that throws may still have broadcast. */
  broadcastAttempted: boolean;
  status: OneClickSwapStatus;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  amountOutFormatted?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  destinationTxHashes?: string[];
};

export type OneClickSwapStore = {
  get(depositAddress: string): Promise<OneClickSwapRecord | null>;
  put(record: OneClickSwapRecord): Promise<void>;
};

export type FundOneClickQuoteArgs = {
  response: OneClickQuoteResponse;
  expected: Omit<OneClickExpectation, 'now'>;
  originChainKey: ChainKey | 'near';
  originSymbol: string;
  /** The origin asset's on-chain decimals, as this app knows them (assetDecimalsForChain). */
  originDecimals: number;
  fromAddress: string;
  /** Sends `amount` (human-readable) of the origin asset to `to`; resolves to the tx hash/signature. */
  send: (to: string, amount: string) => Promise<string>;
  store: OneClickSwapStore;
  submitDepositTx?: (txHash: string, depositAddress: string) => Promise<unknown>;
  now?: () => number;
};

export class OneClickDepositError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneClickDepositError';
  }
}

export async function fundOneClickQuote(args: FundOneClickQuoteArgs): Promise<OneClickSwapRecord> {
  const now = args.now ?? Date.now;
  const {response, store} = args;

  assertOneClickQuoteSafeToFund(response, {...args.expected, now: now()});
  const depositAddress = response.quote.depositAddress as string;

  // Any earlier attempt that reached send() blocks another one, even if
  // it threw: a timeout can come back after the transfer was broadcast,
  // and paying the same deposit address twice is not recoverable here.
  const existing = await store.get(depositAddress);
  if (existing && (existing.broadcastAttempted || existing.depositTxHash)) {
    throw new OneClickDepositError('A payment for this quote was already sent or attempted. Check its status instead of sending again.');
  }

  if (!Number.isInteger(args.originDecimals) || args.originDecimals < 0) {
    throw new OneClickDepositError("Couldn't determine this asset's decimals, so the amount can't be sent exactly.");
  }
  const payAmount = formatUnits(BigInt(response.quote.amountIn), args.originDecimals);

  const created = now();
  let record: OneClickSwapRecord = {
    depositAddress,
    quoteResponse: response,
    originChainKey: args.originChainKey,
    originSymbol: args.originSymbol,
    payAmount,
    fromAddress: args.fromAddress,
    depositTxHash: null,
    broadcastAttempted: false,
    status: 'SENDING',
    createdAt: created,
    updatedAt: created,
  };
  await store.put(record);

  try {
    assertOneClickDepositWindowOpen(response.quote, now());
  } catch (err) {
    record = {...record, status: 'SEND_FAILED', updatedAt: now(), lastError: err instanceof Error ? err.message : String(err)};
    await store.put(record);
    throw err;
  }

  record = {...record, broadcastAttempted: true, updatedAt: now()};
  await store.put(record);

  let txHash: string;
  try {
    txHash = await args.send(depositAddress, payAmount);
  } catch (err) {
    record = {...record, status: 'SEND_FAILED', updatedAt: now(), lastError: err instanceof Error ? err.message : String(err)};
    await store.put(record);
    throw err;
  }

  record = {...record, depositTxHash: txHash, status: 'PENDING_DEPOSIT', updatedAt: now()};
  await store.put(record);

  if (args.submitDepositTx) {
    await args.submitDepositTx(txHash, depositAddress).catch(() => {});
  }
  return record;
}

// How long past the deposit deadline an unconfirmed send keeps being
// checked — long enough for a slow origin chain to confirm a deposit
// that was broadcast just in time.
export const ONE_CLICK_POLL_GRACE_MS = 2 * 60 * 60 * 1000;

/** Whether this swap still needs status checks. */
export function shouldPollOneClickSwap(record: OneClickSwapRecord, now: number = Date.now()): boolean {
  if (record.status === 'SENDING' || record.status === 'SEND_FAILED' || record.status === 'PENDING_DEPOSIT') {
    const deadline = record.quoteResponse.quote.deadline ? Date.parse(record.quoteResponse.quote.deadline) : NaN;
    // Never broadcast means there's nothing to find on 1Click's side.
    if (!record.broadcastAttempted) return false;
    if (!Number.isFinite(deadline)) return true;
    return now < deadline + ONE_CLICK_POLL_GRACE_MS;
  }
  return !isOneClickStatusFinal(record.status);
}

/**
 * Fetches 1Click's status for a swap and stores it. A status response
 * whose quote carries a different signature than the one this app
 * funded is ignored — status is display-only, but it must still be about
 * the quote the user actually paid.
 */
export async function refreshOneClickSwap(
  record: OneClickSwapRecord,
  {fetchStatus, store, now = Date.now}: {fetchStatus: (depositAddress: string) => Promise<OneClickStatusResponse>; store: OneClickSwapStore; now?: () => number},
): Promise<OneClickSwapRecord> {
  const status = await fetchStatus(record.depositAddress);
  const statusSignature = status?.quoteResponse?.signature;
  if (statusSignature && statusSignature !== record.quoteResponse.signature) {
    throw new OneClickDepositError("NEAR Intents returned status for a different quote than the one you paid — ignoring it.");
  }
  const details = status.swapDetails ?? {};
  const next: OneClickSwapRecord = {
    ...record,
    status: status.status,
    updatedAt: now(),
    lastError: undefined,
    amountOutFormatted: details.amountOutFormatted ?? record.amountOutFormatted,
    refundedAmountFormatted: details.refundedAmountFormatted ?? record.refundedAmountFormatted,
    refundReason: details.refundReason ?? record.refundReason,
    destinationTxHashes: details.destinationChainTxHashes?.map(t => t.hash) ?? record.destinationTxHashes,
  };
  await store.put(next);
  return next;
}
