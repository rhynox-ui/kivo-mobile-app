// src/core/relayQuote.ts
//
// Ported from mango-mobile's own src/bridge/relayBridge.js — same Relay
// Protocol request/response shape, same retry policy, hitting Relay's
// public API directly (https://api.relay.link) rather than the site's
// own backend proxy: mobile has no "same origin" server to route
// through the way the website does, and Kivo Pro is in exactly the
// same position, so this follows mobile's pattern, not the site's.
//
// Every quote is tagged with the intent it was requested under (see
// quoteIntents below) — src/core/executeRelayQuote.ts reads this to run
// the pre-sign firewall before signing anything. This is the same
// pattern mango-bridge.jsx's own relaybridge.js uses: intent is built
// from the REQUEST body, never read back out of the response, or the
// check would be circular and worthless.
//
// Fee: Kivo's app fee stays at its normal 0.5% rate. Sponsorship is
// independent from the app fee: Relay's granular sponsorship API lets us
// sponsor execution only, so we do not inflate the user's app fee to hide
// sponsorship losses or accidentally sponsor Kivo's own app fee.
//
// Real gas sponsorship: Relay's own "Fee Sponsorship" feature
// (docs.relay.link/features/fee-sponsorship) — separate from the App
// Fees this file already sends via `appFees` below, which fund the
// protocol's own margin, not gas. Sponsorship needs an API key tied to
// a funded app balance. That key is held by Kivo backend, never by this app
// (an uploaded audit's H-01, verified: it used to be committed here and
// shipped in the APK, where anyone could extract it and spend Kivo's
// Relay balance). Quotes go through Kivo's proxy (Kivo backend
// pro-proxies.js), which adds the key, keeps sponsorship only on quotes
// carrying Kivo's fee, and caps maxSubsidizationAmount server-side.
//
// Important, confirmed against Relay's own docs: sponsorship covers
// DESTINATION-chain fees only — the user still pays origin-chain gas
// themselves, on every trade, sponsored or not. UPDATE (stale comment
// fixed): this was true when first written but no longer is —
// TokenTradeScreen.tsx's payOrigin now lets a Buy pay from a DIFFERENT
// chain than the token being bought (a genuine cross-chain buy,
// fromChainKey !== toChainKey), and executeRelayQuote.ts signs each
// step on whichever chain Relay's own response actually names, not a
// single assumed chain. Same-chain buy/sell is still the common case
// (Sell, and a Buy where the user hasn't picked a different payOrigin
// chain), but it is no longer the ONLY case — verify with a real,
// funded key whether Relay's sponsorship has a visible effect on a
// genuine cross-chain trade now that one is real and reachable, not
// hypothetical future work.

import {formatUnits} from 'viem';
import {currencyAddress, MAINNET_CHAIN_IDS, type ChainKey} from './chainData.ts';
import {getViemChain} from './chainRegistry.ts';
import {assertRelayGaslessEvmAvailable} from './relayGaslessEvm.ts';
import {appFeeBps, feeRecipientForQuote, isFeeExemptWallet, maxSubsidizationAmountUsdcUnits} from './fees.ts';
import {buildTransactionIntent, type TransactionIntent} from './txIntentFirewall.ts';

// Where quotes go and whether sponsorship is requested are set by each
// client at startup (configureRelayEndpoints). Both clients send quotes
// through Kivo's own backend (/api/relay/quote): it fixes the browser CORS
// problem, enforces Kivo's fee recipient and rate server-side, and is the
// only place the Relay API key (needed for sponsorship) lives. The key is
// never shipped in the app. Without a key the backend strips sponsorship
// fields, so asking for it is always safe.
let RELAY_SPONSORSHIP_ENABLED = false;
let RELAY_QUOTE_URL = 'https://api.relay.link/quote';

export function configureRelayEndpoints(config: {quoteUrl?: string; sponsorship?: boolean}): void {
  if (config.quoteUrl) RELAY_QUOTE_URL = config.quoteUrl;
  if (typeof config.sponsorship === 'boolean') RELAY_SPONSORSHIP_ENABLED = config.sponsorship;
}

const RELAY_QUOTE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RELAY_QUOTE_MAX_ATTEMPTS = 4;
const RELAY_QUOTE_BACKOFF_MS = 500;

async function assertQuoteOriginGaslessCapability(params: GetRelayQuoteParams): Promise<void> {
  // Kivo Fomo execution is gasless on EVM. Do not allow Relay to return a
  // quote for an EVM source chain that this executor cannot actually sponsor.
  // Solana has its separate sponsored executor and therefore skips this EVM
  // Calibur check.
  if (!params.originGasOverhead || params.fromChainKey === 'solana') return;
  await assertRelayGaslessEvmAvailable(getViemChain(params.fromChainKey));
}

async function postRelayQuote(body: Record<string, unknown>): Promise<Response> {
  let lastNetworkError: unknown = null;
  for (let attempt = 0; attempt < RELAY_QUOTE_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(RELAY_QUOTE_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastNetworkError = err;
      if (attempt === RELAY_QUOTE_MAX_ATTEMPTS - 1) throw err;
      await new Promise<void>(resolve => setTimeout(() => resolve(), RELAY_QUOTE_BACKOFF_MS * 2 ** attempt));
      continue;
    }
    if (res.ok || !RELAY_QUOTE_RETRYABLE_STATUS.has(res.status) || attempt === RELAY_QUOTE_MAX_ATTEMPTS - 1) {
      return res;
    }
    await new Promise<void>(resolve => setTimeout(() => resolve(), RELAY_QUOTE_BACKOFF_MS * 2 ** attempt));
  }
  throw lastNetworkError ?? new Error('Relay quote request failed without a response.');
}

export type GetRelayQuoteParams = {
  fromChainKey: ChainKey;
  toChainKey: ChainKey;
  /** Origin currency address — pass directly for a token not in chainData.ts's verified list (any arbitrary searched token); omit to resolve fromAsset via currencyAddress(). */
  originCurrency?: string;
  /** Symbol to resolve via currencyAddress() when originCurrency isn't passed directly. */
  fromAsset?: string;
  /** Destination currency address — pass directly for a token not in chainData.ts's verified list; omit to resolve toAsset via currencyAddress(). */
  destinationCurrency?: string;
  toAsset?: string;
  amountBaseUnits: string;
  userAddress: string;
  recipientAddress?: string;
  originAmountUsd?: number | null;
  /** Basis-points string ("50" = 0.5%), or omit entirely for Auto — Relay's own front-running-aware default. Never a client-side guess: when set, this is the literal bound Relay quotes against and the number shown back in details.slippageTolerance.total. */
  slippageTolerance?: string;
  /** Extra origin gas reserved for Relay's Calibur/EIP-7702 gasless wrapper. Only set when Relay gasless execution is enabled. */
  originGasOverhead?: string;
  /**
   * True for a pure cash-to-cash conversion (ConvertCashScreen's own
   * USDG-on-Robinhood <-> USDC-elsewhere move, not a token trade) —
   * sends Relay's own appFees as 0bps instead of fees.ts's normal rate,
   * and skips requesting destination-gas sponsorship for this call.
   * Sponsorship's own fee floor (fees.ts's sponsoredFeeFloorUsd) exists
   * specifically so a sponsored trade's fee always covers what
   * sponsoring it costs the protocol — a fee-waived call collects
   * nothing to cover that with, so it simply doesn't ask for
   * sponsorship rather than silently eating an uncovered cost. Real
   * Relay/network costs (gas, Relay's own relayer fee) are unaffected
   * either way and stay visible in the quote — never fabricated as
   * zero, only Kivo's own cut is.
   */
  waiveAppFee?: boolean;
};

/** One transaction Relay needs signed — EVM-shaped (to/data/value/chainId) or Solana-shaped (instructions), per executeRelayQuote.ts's own dispatch. */
export type RelayTransactionStepItem = {
  status?: string;
  data?: {
    chainId?: number;
    to?: string;
    data?: string;
    value?: string;
    instructions?: {keys: {pubkey: string; isSigner: boolean; isWritable: boolean}[]; programId: string; data: string}[];
    addressLookupTableAddresses?: string[];
  };
};
export type RelayStep = {kind: string; requestId?: string; items: RelayTransactionStepItem[]};

/** Raw Relay quote response — typed only for the fields this app actually reads, not the full schema. */
export type RelayQuote = {
  fees?: {
    gas?: {amountUsd?: string | number};
    relayer?: {amountUsd?: string | number};
    relayerService?: {amountUsd?: string | number};
    app?: {amountUsd?: string | number};
  };
  expandedPriceImpact?: {
    execution?: {usd?: string | number};
    swap?: {usd?: string | number};
    relay?: {usd?: string | number};
    app?: {usd?: string | number};
    sponsored?: {usd?: string | number};
  };
  details?: {
    timeEstimate?: string | number;
    // Both currencyIn/currencyOut also carry `currency.chainId`/
    // `currency.address` and (currencyIn) `amount` — real fields on
    // Relay's own response, read by txIntentFirewall.ts's pre-sign
    // checks rather than by summarizeQuote() below, but typed here too
    // so this one type stays the single source of truth for what a
    // quote object actually looks like, instead of two independently
    // hand-typed subsets of the same response drifting apart.
    currencyIn?: {amount?: string; amountUsd?: string | number; currency?: {chainId?: number; address?: string}};
    currencyOut?: {
      amount?: string;
      amountFormatted?: string;
      amountUsd?: string | number;
      /** Relay's guaranteed/minimum destination amount after slippage. */
      minimumAmount?: string;
      currency?: {chainId?: number; address?: string; decimals?: number};
    };
    recipient?: string;
    swapImpact?: {percent?: string | number};
    totalImpact?: {percent?: string | number};
    expandedPriceImpact?: {
      execution?: {usd?: string | number};
      swap?: {usd?: string | number};
      relay?: {usd?: string | number};
      app?: {usd?: string | number};
      sponsored?: {usd?: string | number};
    };
    slippageTolerance?: {total?: string | number};
  };
  steps?: RelayStep[];
};

/**
 * Keyed on the quote object's own identity, not a property written onto
 * it — nothing that serializes, logs, or clones the quote carries the
 * intent with it, and a quote object that didn't come from
 * getRelayQuote() has no entry here at all, which executeRelayQuote.ts
 * treats as a refusal to sign rather than as permission.
 */
const quoteIntents = new WeakMap<object, {intent: TransactionIntent; quotedAt: number}>();

/** Reads back the intent+timestamp getRelayQuote() tagged this exact quote object with — undefined for any quote not obtained from getRelayQuote(). */
export function intentForQuote(quote: RelayQuote): {intent: TransactionIntent; quotedAt: number} | undefined {
  return quoteIntents.get(quote);
}

const HIGH_IMPACT_REQUOTE_THRESHOLD_PCT = 2;

function rawQuoteOutputAmount(quote: RelayQuote): bigint | null {
  const raw = quote?.details?.currencyOut?.amount;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function isBetterExactInputQuote(candidate: RelayQuote, current: RelayQuote): boolean {
  const candidateOut = rawQuoteOutputAmount(candidate);
  const currentOut = rawQuoteOutputAmount(current);
  return candidateOut !== null && currentOut !== null && candidateOut > currentOut;
}

export async function getRelayQuote(params: GetRelayQuoteParams): Promise<RelayQuote> {
  await assertQuoteOriginGaslessCapability(params);
  const {fromChainKey, toChainKey, fromAsset, toAsset, originCurrency, destinationCurrency, amountBaseUnits, userAddress, recipientAddress, originAmountUsd, slippageTolerance, originGasOverhead, waiveAppFee} = params;

  const resolvedOriginCurrency = originCurrency ?? (fromAsset ? currencyAddress(fromChainKey, fromAsset) : undefined);
  const resolvedDestinationCurrency = destinationCurrency ?? (toAsset ? currencyAddress(toChainKey, toAsset) : undefined);
  if (!resolvedOriginCurrency || !resolvedDestinationCurrency) {
    throw new Error('getRelayQuote requires either an explicit currency address or a resolvable asset symbol for both sides.');
  }

  // Real sponsorship only exists once Kivo backend holds a funded Relay
  // key (see this file's header) — this is the one place that asks for
  // it, not the caller. Never active on a
  // fee-waived call (waiveAppFee's own doc comment explains why).
  // Owner/protocol wallets pay no Kivo app fee. Keep the exemption here,
  // at the quote construction boundary so the displayed receive amount and
  // the signed Relay intent are both based on the same zero-fee request.
  // Exempt wallets also do not request Kivo-paid destination sponsorship:
  // the exemption is a fee exemption, not an unlimited gas subsidy.
  const feeExempt = isFeeExemptWallet(userAddress);
  const sponsorshipRequested = !waiveAppFee && RELAY_SPONSORSHIP_ENABLED && !feeExempt;
  // On expensive chains, a tiny outright-sponsored trade can cost Kivo
  // more than the user's 0.5% app fee. Keep the gasless UX where it is
  // economically sane; otherwise let Relay quote the normal user-paid
  // execution cost instead of silently turning Kivo into the gas payer.
  // Kivo's trading contract is the Fomo-style UX: Relay sponsorship is
  // part of the trade, not an optional optimization based on trade size.
  // Never silently quote a normal native-gas transaction because a small
  // or expensive-chain trade is economically inconvenient for the protocol.
  const sponsorshipActive = sponsorshipRequested;

  const body = {
    user: userAddress,
    recipient: recipientAddress || userAddress,
    originChainId: MAINNET_CHAIN_IDS[fromChainKey],
    destinationChainId: MAINNET_CHAIN_IDS[toChainKey],
    originCurrency: resolvedOriginCurrency,
    destinationCurrency: resolvedDestinationCurrency,
    amount: amountBaseUnits,
    tradeType: 'EXACT_INPUT',
    // toChainKey, not fromChainKey — Relay's sponsorship (and the fee
    // floor protecting it) is priced against the chain whose fees
    // actually get sponsored: the destination, per Relay's own docs.
    appFees: [{recipient: feeRecipientForQuote(), fee: waiveAppFee || feeExempt ? '0' : appFeeBps(originAmountUsd)}],
    ...(sponsorshipActive
      ? {
          subsidizeFees: true,
          sponsoredFeeComponents: ['execution'],
          // Separate from subsidizeFees, per Relay's own docs: covers
          // the SOL rent a new destination-side token account needs
          // (e.g. this wallet's first time receiving a given SPL token)
          // — the real, ground-truth cause of a live "insufficient
          // lamports" failure on a Solana destination. Only meaningful
          // when Solana is actually the destination; omitted otherwise
          // so an EVM destination never sends a field Relay has no use
          // for there.
          ...(toChainKey === 'solana' ? {subsidizeRent: true} : {}),
          // Relay refuses to sponsor AT ALL past this cap (not a partial
          // sponsor) — generous relative to real cost so normal trades
          // always clear it, but still a real ceiling on what one
          // request can draw from the app balance.
          maxSubsidizationAmount: maxSubsidizationAmountUsdcUnits(toChainKey),
        }
      : {}),
    // Additive only — omitted entirely on Auto, same as
    // mango-mobile's own relayBridge.js, so leaving slippage on Auto
    // is a real "field not sent" rather than a client-guessed default.
    ...(slippageTolerance ? {slippageTolerance} : {}),
    ...(originGasOverhead ? {originGasOverhead} : {}),
  };

  const res = await postRelayQuote(body);
  if (!res.ok) {
    // Real gap fix: this used to throw a bare 'Quote failed' with no
    // detail at all — every other repo's identical function (mobile's
    // relayBridge.js, the site's relaybridge.js) surfaces the real
    // status + body text, which is exactly what's needed to tell a
    // genuine no-liquidity/AMOUNT_TOO_LOW rejection from a transient
    // 5xx apart instead of guessing.
    const text = await res.text().catch(() => '');
    let reason = text.trim();
    try { const parsed = JSON.parse(reason) as {message?: string; error?: string}; reason = parsed.message || parsed.error || reason; } catch {}
    throw new Error(`Relay quote failed (${res.status}): ${reason || res.statusText || 'Relay gave no reason. Try again in a minute.'}`);
  }
  let quote = (await res.json()) as RelayQuote;

  // Relay already runs a competitive filler market, so do not add another
  // router or alter normal quotes. The one safe optimization here is a
  // bounded second quote when Relay itself reports meaningful swap impact:
  // a thin/fast-moving market or a different available filler can produce
  // a materially better result a moment later. This applies to BOTH
  // same-chain and cross-chain routes; the second request is the exact same
  // sponsored/app-fee request, so sponsorship behavior is unchanged. We keep
  // the first quote if the second is not strictly better by exact-input
  // output, and we never turn a valid first quote into a failure.
  const initialImpact = Number(quote?.details?.swapImpact?.percent ?? quote?.details?.totalImpact?.percent);
  if (
    Number.isFinite(initialImpact) &&
    Math.abs(initialImpact) > HIGH_IMPACT_REQUOTE_THRESHOLD_PCT
  ) {
    try {
      const retry = await postRelayQuote(body);
      if (retry.ok) {
        const candidate = (await retry.json()) as RelayQuote;
        if (isBetterExactInputQuote(candidate, quote)) quote = candidate;
      }
    } catch {
      // Quote optimization is strictly best-effort. Never turn a valid
      // first quote into a failure because the second request timed out.
    }
  }

  // Built from `body` — what was actually asked for — never from the
  // response; reading intent back out of the answer would make the
  // firewall check circular. quotedAt rides in the same entry so
  // executeRelayQuote.ts can refuse a stale quote's gas/rate numbers
  // without a second, separate tagging mechanism.
  if (quote && typeof quote === 'object') {
    quoteIntents.set(quote, {
      intent: buildTransactionIntent({
        originChainId: body.originChainId,
        destinationChainId: body.destinationChainId,
        originCurrency: body.originCurrency,
        destinationCurrency: body.destinationCurrency,
        amountBaseUnits: body.amount,
        userAddress: body.user,
        recipientAddress: body.recipient,
      }),
      quotedAt: Date.now(),
    });
  }

  return quote;
}

export type QuoteSummary = {
  totalFeeUsd: number | null;
  etaSeconds: number | null;
  receivedAmountFormatted: string | null;
  payAmountUsd: number | null;
  receiveAmountUsd: number | null;
  priceImpactPct: number | null;
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Same field-name mapping as mango-mobile's DexScreen.tsx summarizeQuote
 * — confirmed there directly against @relayprotocol/relay-sdk's
 * generated api.d.ts. `fallbackDecimals` is only used if Relay's own
 * response omits currency.decimals on the destination side, which in
 * practice it doesn't for a genuine route.
 */
export function summarizeQuote(quote: RelayQuote, fallbackDecimals: number): QuoteSummary {
  const fees = quote?.fees ?? {};
  const details = quote?.details ?? {};
  const expanded = quote?.expandedPriceImpact ?? details?.expandedPriceImpact;

  // Relay's expandedPriceImpact is the current quote-level fee model. Use
  // it first so the UI reports what the user actually pays after Kivo's
  // sponsorship, then retain the deprecated fees object as a compatibility
  // fallback for older/partial responses.
  const executionUsd = num(expanded?.execution?.usd);
  const swapUsd = num(expanded?.swap?.usd);
  const relayUsd = num(expanded?.relay?.usd);
  const expandedAppUsd = num(expanded?.app?.usd);
  const sponsoredUsd = num(expanded?.sponsored?.usd);
  const expandedParts = [executionUsd, swapUsd, relayUsd, expandedAppUsd].filter((v): v is number => v !== null);
  const expandedTotal = expandedParts.length > 0
    ? Math.max(0, expandedParts.reduce((a, b) => a + Math.abs(b), 0) - Math.abs(sponsoredUsd ?? 0))
    : null;

  const sourceGasUsd = num(fees?.gas?.amountUsd);
  const relayerUsd = num(fees?.relayer?.amountUsd);
  const relayerServiceUsd = num(fees?.relayerService?.amountUsd);
  const relayerTotalUsd = relayerUsd ?? relayerServiceUsd;
  const appUsd = num(fees?.app?.amountUsd);
  const feeParts = [sourceGasUsd, relayerTotalUsd, appUsd].filter((v): v is number => v !== null);
  const legacyTotalFeeUsd = feeParts.length > 0 ? feeParts.reduce((a, b) => a + b, 0) : null;
  const totalFeeUsd = expandedTotal ?? legacyTotalFeeUsd;

  const etaSeconds = num(details?.timeEstimate);

  const currencyOut = details?.currencyOut;
  let receivedAmountFormatted: string | null = null;
  if (currencyOut?.amountFormatted) {
    receivedAmountFormatted = String(currencyOut.amountFormatted);
  } else if (currencyOut?.amount) {
    try {
      receivedAmountFormatted = formatUnits(BigInt(currencyOut.amount), currencyOut?.currency?.decimals ?? fallbackDecimals);
    } catch {
      receivedAmountFormatted = null;
    }
  }

  const payAmountUsd = num(details?.currencyIn?.amountUsd);
  const receiveAmountUsd = num(details?.currencyOut?.amountUsd);
  const priceImpactPct = num(details?.swapImpact?.percent ?? details?.totalImpact?.percent);

  return {totalFeeUsd, etaSeconds, receivedAmountFormatted, payAmountUsd, receiveAmountUsd, priceImpactPct};
}
