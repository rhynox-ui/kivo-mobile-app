// src/core/oneClick.ts
//
// NEAR Intents 1Click API client, plus the safety checks a quote must
// pass before this app sends a single token to its deposit address.
//
// WHY 1CLICK. Relay has no NEAR support (its chain VMs stop at EVM, SVM,
// BVM, TVM and a few others), CCTP has no NEAR domain, and Omni Bridge
// needs a NEAR account and NEAR gas on the user's side. 1Click is NEAR
// Intents' own quoting service: the user sends the origin asset to a
// one-time deposit address on the origin chain, and solvers deliver the
// destination asset (on NEAR or any other supported chain).
//
// WHY THE CHECKS MATTER MORE HERE THAN FOR RELAY. A Relay route is a
// contract call the user signs, so txIntentFirewall.ts can bound what it
// does. A 1Click route is a plain transfer to an address the API hands
// back — once funds land there, the only protections left are the refund
// address and the deadline. So everything that decides where the money
// goes is checked before sending:
//
//   - Signature. 1Click signs every quote (request fields, deposit
//     address, amounts, deadline) with its manager key. The public key is
//     pinned below, so a deposit address swapped anywhere between 1Click
//     and this app — a compromised proxy, CDN or network — fails here.
//     This is the port of the SDK's own verifyQuoteSignature (see
//     quoteHash below), tested against its staging-signed fixtures in
//     scripts/verify-one-click.mjs.
//   - Echo. The signed request must be the one this app asked for:
//     same assets, amount, recipient and refund address, EXACT_INPUT on
//     origin-chain deposit/refund, slippage within what the user chose.
//   - Deadline. After `deadline` the deposit address goes inactive and
//     1Click's own docs say funds sent late "may be lost". A quote must
//     leave a real margin, and callers re-check right before sending.
//   - Memo. Some chains need a memo with the deposit; this app never
//     sends one, so a quote that requires it is refused rather than
//     funded without it.
//
// NOT SIGNED: appFees. The SDK leaves appFees out of the signed payload,
// so a fee changed in transit would still verify. The echo check below
// compares them to what was requested anyway.
//
// FEE. Same model as every Relay trade — kivoFeeUsd()/kivoFeeBps() in
// fees.ts are the one source of that rate. 1Click pays it out inside NEAR
// Intents to ONE_CLICK_FEE_ACCOUNT. No 1Click partner JWT is used, so
// 1Click adds its own small fee on top, paid by the user — Mango keeps
// its full fee.
//
// NEAR receive/deposit UI is wired through Profile and Convert; token trades use
// the dedicated NEAR trade path, while cross-chain USDC moves use 1Click.

import {ed25519} from '@noble/curves/ed25519.js';
import {sha256} from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import type {ChainKey} from './chainData';
import {kivoFeeBps, type FeeToken} from './fees.ts';

// 1Click's production quote-signing key, as pinned in the official SDK
// (@defuse-protocol/one-click-sdk-typescript, src/quote-signature.ts).
export const ONE_CLICK_MANAGER_PUB_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

export const ONE_CLICK_BASE_URL = 'https://1click.chaindefuser.com';
// Kivo calls the official 1Click API directly. The quote signature is pinned locally, so a network or proxy cannot change a deposit address without failing the firewall.
export const ONE_CLICK_PROXY_BASE_URL = ONE_CLICK_BASE_URL;

// The NEAR Intents account Mango's app fee is paid to — Mango's own
// NEAR wallet. Must match the mango-api Worker's NEAR_FEE_ACCOUNT, or
// the quote check below refuses every proxied quote.
export const ONE_CLICK_FEE_ACCOUNT: string | null = 'widekingdom6862.near';

const ED25519_PREFIX = 'ed25519:';

// A deposit must be broadcast with at least this long left before the
// quote's deadline. Origin-chain confirmation plus 1Click noticing the
// deposit takes minutes, not seconds, on slower chains.
export const ONE_CLICK_MIN_DEADLINE_MARGIN_MS = 10 * 60 * 1000;

export type OneClickAppFee = {recipient: string; fee: number};

export type OneClickQuoteRequest = {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  deadline: string;
  depositMode?: 'SIMPLE' | 'MEMO';
  quoteWaitingTimeMs?: number | null;
  referral?: string | null;
  virtualChainRecipient?: string | null;
  virtualChainRefundRecipient?: string | null;
  customRecipientMsg?: string | null;
  appFees?: OneClickAppFee[];
  sessionId?: string;
  connectedWallets?: string[];
};

export type OneClickQuote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate?: number;
  refundFee?: string;
  withdrawFee?: string;
};

export type OneClickQuoteResponse = {
  correlationId?: string;
  timestamp: string;
  signature: string;
  quoteRequest: OneClickQuoteRequest;
  quote: OneClickQuote;
};

export type OneClickStatus = 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';

export type OneClickStatusResponse = {
  correlationId?: string;
  quoteResponse: OneClickQuoteResponse;
  status: OneClickStatus;
  updatedAt: string;
  swapDetails?: {
    amountOut?: string;
    amountOutFormatted?: string;
    refundedAmount?: string;
    refundedAmountFormatted?: string;
    refundReason?: string;
    depositedAmount?: string;
    originChainTxHashes?: {hash: string; explorerUrl: string}[];
    destinationChainTxHashes?: {hash: string; explorerUrl: string}[];
  };
};

export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
};

/** No further status change will come for these — stop polling. */
export function isOneClickStatusFinal(status: OneClickStatus): boolean {
  return status === 'SUCCESS' || status === 'REFUNDED' || status === 'FAILED';
}

// 1Click's own blockchain ids for the ChainKeys it shares with this app.
// Robinhood Chain ('hood'?) and HyperEVM ('hlevm'?) are left out until
// confirmed against a live /v0/tokens response; Arc and Stable are not
// on 1Click at all.
export const ONE_CLICK_BLOCKCHAIN: Partial<Record<ChainKey, string>> = {
  ethereum: 'eth',
  base: 'base',
  arbitrum: 'arb',
  bnb: 'bsc',
  avalanche: 'avax',
  solana: 'sol',
  plasma: 'plasma',
  xlayer: 'xlayer',
};

/**
 * Finds 1Click's asset id for a token (by contract address) or a chain's
 * native coin (contractAddress null, matched by symbol) in a live
 * /v0/tokens list. Null — never a guess — when nothing matches exactly.
 */
export function findOneClickAssetId(tokens: OneClickToken[], blockchain: string, contractAddress: string | null, nativeSymbol?: string): string | null {
  const match = tokens.find(t => {
    if (t.blockchain !== blockchain) return false;
    if (contractAddress === null) return !t.contractAddress && t.symbol === nativeSymbol;
    return typeof t.contractAddress === 'string' && t.contractAddress.toLowerCase() === contractAddress.toLowerCase();
  });
  return match?.assetId ?? null;
}

/**
 * True for the account id shapes NEAR Intents uses: a 64-hex implicit
 * account (the form 1Click's own fixtures use for app-fee recipients),
 * a lowercase 0x EVM address (an Intents account owned by an EVM key),
 * or a named account such as mango.near.
 */
export function isNearIntentsAccountId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^[0-9a-f]{64}$/.test(value) || /^0x[0-9a-f]{40}$/.test(value)) return true;
  return value.length >= 2 && value.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value);
}

/**
 * Kivo's app fee as 1Click appFees (fees.ts kivoFeeBps), classified by the
 * token being traded on its own chain (`feeToken`; NEAR when omitted).
 * Pass the same array to the quote request and to
 * assertOneClickQuoteSafeToFund's expectation. Throws while no fee account
 * is configured rather than quoting without the fee.
 */
export function oneClickAppFees(originAmountUsd?: number | null, feeAccount: string | null = ONE_CLICK_FEE_ACCOUNT, feeToken: FeeToken = {chainKey: 'near', tokenAddress: null}): OneClickAppFee[] {
  if (!isNearIntentsAccountId(feeAccount)) {
    throw new Error("NEAR routes aren't available yet — Mango's NEAR fee account isn't set up.");
  }
  return [{recipient: feeAccount, fee: Number(kivoFeeBps({amountUsd: originAmountUsd, ...feeToken}))}];
}

// ---------------------------------------------------------------------
// Quote signature — a line-for-line port of the SDK's quote-signature.ts
// (buildSignedQuoteRequest / buildSignedQuote / hashQuote), using this
// app's existing @noble + bs58 dependencies instead of the SDK's axios,
// tweetnacl and json-stable-stringify.

/** json-stable-stringify's output: keys sorted at every level, undefined object values dropped. */
export function stableStringify(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v) ?? 'null').join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = stableStringify(record[key]);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

function signedQuoteRequest(r: OneClickQuoteRequest) {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: r.quoteWaitingTimeMs ? r.quoteWaitingTimeMs : undefined,
    referral: r.referral ? r.referral : undefined,
    virtualChainRecipient: r.virtualChainRecipient ? r.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: r.virtualChainRefundRecipient ? r.virtualChainRefundRecipient : undefined,
    customRecipientMsg: r.customRecipientMsg ? r.customRecipientMsg : undefined,
  };
}

function signedQuote(q: OneClickQuote, dry: boolean) {
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  if (dry) return amounts;
  return {
    ...amounts,
    depositAddress: q.depositAddress || undefined,
    depositMemo: q.depositMemo || undefined,
    deadline: q.deadline || undefined,
    timeWhenInactive: q.timeWhenInactive || undefined,
    timeEstimate: q.timeEstimate || undefined,
    refundFee: q.refundFee || undefined,
    withdrawFee: q.withdrawFee || undefined,
  };
}

/** The base58 sha256 1Click signs — identical to the SDK's quoteHash(). */
export function oneClickQuoteHash(response: OneClickQuoteResponse): string {
  const payload = {
    ...signedQuoteRequest(response.quoteRequest),
    ...signedQuote(response.quote, response.quoteRequest.dry),
    timestamp: response.timestamp,
  };
  const data = stableStringify(payload) ?? '';
  return bs58.encode(sha256(new TextEncoder().encode(data)));
}

function decodeEd25519(value: string): Uint8Array {
  return bs58.decode(value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value);
}

/** True only when 1Click's manager key signed exactly this quote. Never throws. */
export function verifyOneClickQuoteSignature(response: OneClickQuoteResponse, managerPublicKey: string = ONE_CLICK_MANAGER_PUB_KEY): boolean {
  try {
    const signature = decodeEd25519(response.signature);
    const publicKey = decodeEd25519(managerPublicKey);
    const message = new TextEncoder().encode(oneClickQuoteHash(response));
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Pre-deposit firewall

export class OneClickQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneClickQuoteError';
  }
}

function fail(message: string): never {
  throw new OneClickQuoteError(`${message} Nothing was sent — get a fresh quote and try again.`);
}

export type OneClickExpectation = {
  originAsset: string;
  destinationAsset: string;
  /** Exact input, in the origin asset's base units. */
  amount: string;
  recipient: string;
  recipientType: OneClickQuoteRequest['recipientType'];
  refundTo: string;
  maxSlippageBps: number;
  /** Exactly the app fees this app asked for; omit or [] for none. */
  appFees?: OneClickAppFee[];
  managerPublicKey?: string;
  now?: number;
  minDeadlineMarginMs?: number;
};

function sameAddress(a: string, b: string): boolean {
  // EVM addresses compare case-insensitively (checksum casing); every
  // other format (base58, NEAR account ids) compares exactly.
  const evm = /^0x[0-9a-fA-F]{40}$/;
  return evm.test(a) && evm.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function toBigInt(value: string | undefined, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`The quote's ${field} isn't a valid amount.`);
  return BigInt(value);
}

/** Throws unless the deposit window is still open with the required margin. Call again right before broadcasting. */
export function assertOneClickDepositWindowOpen(quote: OneClickQuote, now: number = Date.now(), marginMs: number = ONE_CLICK_MIN_DEADLINE_MARGIN_MS): void {
  const deadline = quote.deadline ? Date.parse(quote.deadline) : NaN;
  if (!Number.isFinite(deadline)) fail("The quote has no deposit deadline, so there's no guarantee a deposit would be processed.");
  if (deadline - now < marginMs) fail('This quote is too close to its deposit deadline to send safely.');
}

/**
 * Everything a quote must satisfy before this app sends funds to its
 * deposit address. Throws OneClickQuoteError on the first problem.
 */
export function assertOneClickQuoteSafeToFund(response: OneClickQuoteResponse | null | undefined, expected: OneClickExpectation): void {
  if (!response?.quote || !response.quoteRequest) fail('The quote response was incomplete.');
  if (!verifyOneClickQuoteSignature(response, expected.managerPublicKey)) {
    fail("The quote's signature doesn't match NEAR Intents' signing key, so its deposit address can't be trusted.");
  }

  const r = response.quoteRequest;
  const q = response.quote;
  if (r.dry) fail('A preview-only quote has no deposit address.');
  if (r.swapType !== 'EXACT_INPUT') fail('Unexpected swap type in the quote.');
  if (r.depositType !== 'ORIGIN_CHAIN' || r.refundType !== 'ORIGIN_CHAIN') fail('Unexpected deposit or refund type in the quote.');
  if (r.originAsset !== expected.originAsset || r.destinationAsset !== expected.destinationAsset) fail("The quote is for different assets than the ones you chose.");
  if (r.amount !== expected.amount) fail('The quote is for a different amount than you entered.');
  if (r.recipientType !== expected.recipientType || !sameAddress(r.recipient, expected.recipient)) fail('The quote would deliver to a different address than yours.');
  if (!sameAddress(r.refundTo, expected.refundTo)) fail('The quote would refund to a different address than yours.');
  if (!(r.slippageTolerance >= 0 && r.slippageTolerance <= expected.maxSlippageBps)) fail('The quote allows more slippage than you set.');
  if (r.customRecipientMsg) fail('The quote carries a custom recipient message this app never requests.');

  const wantFees = stableStringify(expected.appFees ?? []);
  const gotFees = stableStringify(r.appFees ?? []);
  if (wantFees !== gotFees) fail("The quote's app fees don't match what this app requested.");

  if (!q.depositAddress) fail('The quote has no deposit address.');
  if (q.depositMemo) fail('This route needs a deposit memo, which this app does not support.');

  const amountIn = toBigInt(q.amountIn, 'input amount');
  const amountOut = toBigInt(q.amountOut, 'output amount');
  const minAmountOut = toBigInt(q.minAmountOut, 'minimum output');
  if (amountIn !== BigInt(expected.amount)) fail('The quote would take a different amount than you entered.');
  if (minAmountOut <= 0n || amountOut < minAmountOut) fail("The quote's output amounts don't add up.");

  assertOneClickDepositWindowOpen(q, expected.now ?? Date.now(), expected.minDeadlineMarginMs ?? ONE_CLICK_MIN_DEADLINE_MARGIN_MS);
}

// ---------------------------------------------------------------------
// HTTP

export type OneClickClientOptions = {
  baseUrl?: string;
  /** 1Click partner JWT. Without one, 1Click adds its own fee on top. */
  authToken?: string;
  timeoutMs?: number;
};

async function oneClickFetch<T>(path: string, init: RequestInit, {baseUrl = ONE_CLICK_BASE_URL, authToken, timeoutMs = 20_000}: OneClickClientOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? {'Content-Type': 'application/json'} : {}),
        ...(authToken ? {Authorization: `Bearer ${authToken}`} : {}),
      },
      signal: controller.signal,
      // Same cast goplusTokenSecurity.ts uses: React Native's AbortSignal
      // type and the DOM lib's disagree on `onabort`, not on behavior.
    } as RequestInit);
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = (body as {message?: unknown} | null)?.message;
      throw new Error(typeof message === 'string' && message ? message : `NEAR Intents request failed (${response.status}).`);
    }
    return body as T;
  } catch (err) {
    if (controller.signal.aborted) throw new Error('NEAR Intents took too long to respond — try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchOneClickTokens(options?: OneClickClientOptions): Promise<OneClickToken[]> {
  return oneClickFetch<OneClickToken[]>('/v0/tokens', {method: 'GET'}, options);
}

export function requestOneClickQuote(request: OneClickQuoteRequest, options?: OneClickClientOptions): Promise<OneClickQuoteResponse> {
  return oneClickFetch<OneClickQuoteResponse>('/v0/quote', {method: 'POST', body: JSON.stringify(request)}, options);
}

export function fetchOneClickStatus(depositAddress: string, options?: OneClickClientOptions): Promise<OneClickStatusResponse> {
  return oneClickFetch<OneClickStatusResponse>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {method: 'GET'}, options);
}

/** Tells 1Click about the deposit transaction so it doesn't wait to notice it on-chain. Optional but speeds things up. */
export function submitOneClickDepositTx(txHash: string, depositAddress: string, options?: OneClickClientOptions): Promise<unknown> {
  return oneClickFetch<unknown>('/v0/deposit/submit', {method: 'POST', body: JSON.stringify({txHash, depositAddress})}, options);
}
