// src/core/fees.ts
//
// Ported from mango-bridge.jsx's src/devFeeWallets.js. Uses the SAME fee
// wallet address as the site/mobile/bot — an assumption, not a verified
// business decision: it reuses the existing protocol treasury on the
// theory that Kivo Pro's revenue should land in the same place the
// other three apps' already does. If Kivo Pro is meant to accrue to a
// separate wallet, change DEV_FEE_WALLET here (and only here — see
// scripts/verify-fees.mjs, which pins this file's exported values so a
// future edit can't silently change the effective rate without a
// visible, reviewed diff, the same protection devFeeWallets.js's own
// header describes needing after this exact rate silently drifted once
// already in mango-telegram-bot).

import type {ChainKey} from './chainData';

// Kivo's own fee wallets (set by the Kivo owner).
export const DEV_FEE_WALLET = '0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5';
export const DEV_FEE_WALLET_SOLANA = '2ApuoLHKmNhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';
/** Kivo's fee account on NEAR — the same one the site's NEAR swaps pay (mango-bridge.jsx). */
export const DEV_FEE_WALLET_NEAR = 'widekingdom6862.near';

// Owner/protocol wallets that should never be charged Kivo's own app fee.
// Keep this exact allowlist small and explicit: it is NOT a user-configurable
// exemption and it does not affect the token's own on-chain tax mechanics.
// EVM addresses are case-insensitive; Solana public keys are Base58 and
// case-sensitive. Never lowercase a Solana key or a different key can match.
export const FEE_EXEMPT_WALLETS = new Set<string>([
  DEV_FEE_WALLET.toLowerCase(),
  DEV_FEE_WALLET_SOLANA,
]);

export function isFeeExemptWallet(address?: string | null): boolean {
  if (typeof address !== 'string' || !address.trim()) return false;
  const normalized = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    return FEE_EXEMPT_WALLETS.has(normalized.toLowerCase());
  }
  return FEE_EXEMPT_WALLETS.has(normalized);
}

export const DEV_FEE_PCT = 0.005;
export const DEV_FEE_MAX_USD = 50;
/** Trades below this size pay SMALL_TRADE_MIN_FEE_USD instead of 0.5%... */
export const SMALL_TRADE_BELOW_USD = 10;
export const SMALL_TRADE_MIN_FEE_USD = 0.05;
/** ...capped at 5% of the trade (the server's maximum). */
export const SMALL_TRADE_MAX_FEE_BPS = 500;

/**
 * The real bps value to send Relay (or any bps-shaped fee API) as this
 * request's fee — DEV_FEE_PCT normally, reduced only far enough that the
 * resulting dollar fee never exceeds DEV_FEE_MAX_USD once originAmountUsd
 * is large enough to hit it. originAmountUsd is optional and only ever a
 * real price-derived estimate; omitting it (or passing something
 * non-positive) just returns the flat rate — there is nothing to cap
 * without a real number to cap against.
 */
export function appFeeBps(originAmountUsd?: number | null): string {
  const flatBps = Math.round(DEV_FEE_PCT * 10000);
  if (!(typeof originAmountUsd === 'number' && originAmountUsd > 0)) {
    return String(flatBps);
  }
  // Kivo pays each trade's gas, so a tiny trade at 0.5% loses money. Under
  // $10 the fee is a flat $0.05 instead, but never more than 5% of the trade.
  if (originAmountUsd < SMALL_TRADE_BELOW_USD) {
    const minBps = Math.ceil((SMALL_TRADE_MIN_FEE_USD / originAmountUsd) * 10000);
    return String(Math.max(flatBps, Math.min(minBps, SMALL_TRADE_MAX_FEE_BPS)));
  }
  const flatFeeUsd = originAmountUsd * DEV_FEE_PCT;
  if (flatFeeUsd <= DEV_FEE_MAX_USD) {
    return String(flatBps);
  }
  const cappedBps = Math.round((DEV_FEE_MAX_USD / originAmountUsd) * 10000);
  return String(Math.max(1, Math.min(flatBps, cappedBps)));
}

// ---------------------------------------------------------------------
// Chain-aware fee floor for sponsored gas.
//
// The flat rate above is pure margin math — correct as long as gas is
// the USER's own cost (mobile/site/bot: they hold native gas and pay it
// themselves). Kivo Pro's whole premise is gas SPONSORSHIP (a paymaster
// or fee-payer covers gas so the user doesn't need native tokens — build
// plan §1/§6), which turns gas into a real, chain-dependent cost the
// PROTOCOL eats. A flat 0.5% fee is fine on Solana/Base/most L2s, where
// sponsoring a transaction costs a fraction of a cent — but on Ethereum
// mainnet, sponsoring a small trade can cost more in gas than the flat
// fee collects, turning that trade into a real loss, not reduced margin.
//
// The fix has two parts, and this file only owns the second:
//  1. STRUCTURAL (preferred, per build plan §6): let the paymaster charge
//     gas in the token being traded instead of the protocol floating the
//     cost outright. Zero cost to the protocol, so the flat rate above
//     stays pure margin regardless of chain — use this wherever the
//     chosen AA provider (Phase 0 spike) supports it.
//  2. SAFETY NET (below): for any trade where gas IS being sponsored
//     outright, the fee must never fall below what that sponsorship
//     costs plus a minimum margin — appFeeBpsForSponsoredTrade() raises
//     the bps sent to Relay for exactly the small-trade-on-an-expensive-
//     chain case where the flat rate alone would lose money.
//
// SPONSORSHIP_COST_ESTIMATE_USD below is a conservative, STATIC estimate
// per chain — real gas prices move constantly (Ethereum mainnet
// especially, which can 5-10x during congestion), so this is a floor
// calibrated to be safely high under normal conditions, not a live
// quote. Replace with real-time gas-price-aware estimation (a viem
// estimateFeesPerGas() call + a native-asset price feed, per chain) once
// Phase 0's account-abstraction spike has real sponsored-transaction
// cost data to calibrate against — tracked, not solved, here.
//
// A Record (not Partial) on purpose, same discipline chainData.ts's own
// currencyAddress() uses: a chain added to ChainKey without an entry
// here is a compile error, not a silent gap that lets an unsponsored-
// cost chain slip through with no floor at all.
export const SPONSORSHIP_COST_ESTIMATE_USD: Record<ChainKey, number> = {
  ethereum: 2.5,
  base: 0.02,
  bnb: 0.1,
  robinhood: 0.05,
  stable: 0.02,
  solana: 0.001,
  arbitrum: 0.05,
  avalanche: 0.05,
  abstract: 0.05,
  hyperevm: 0.05,
  ink: 0.02,
  plasma: 0.02,
  unichain: 0.02,
  xlayer: 0.05,
  // Base fee is pinned around 20 gwei and paid in USDC, so a swap-sized
  // transaction costs well under a cent.
  arc: 0.01,
};

// Minimum profit the protocol wants on TOP of covering the sponsorship
// cost above — without this, appFeeBpsForSponsoredTrade() would only
// break even on the gas-cost floor, not actually earn anything on the
// trades it protects.
export const MIN_SPONSORSHIP_MARGIN_USD = 0.05;

/** What the fee needs to be, in dollars, to cover sponsoring gas on this chain plus the minimum margin. */
export function sponsoredFeeFloorUsd(chainKey: ChainKey): number {
  return SPONSORSHIP_COST_ESTIMATE_USD[chainKey] + MIN_SPONSORSHIP_MARGIN_USD;
}

// Relay's own per-request subsidization cap: it refuses to sponsor a
// request AT ALL (never partially) once the real cost would exceed
// this, per its own docs — so this needs to sit comfortably above the
// real cost estimate, not track it precisely, or a normal trade risks
// silently losing its sponsorship over a cost spike. 5x the existing
// floor (itself already cost-plus-margin) leaves real room on every
// chain in SPONSORSHIP_COST_ESTIMATE_USD, including Ethereum mainnet's
// own volatility, while still bounding what any single request can draw
// from the app balance.
const MAX_SUBSIDIZATION_MULTIPLE = 5;

/** maxSubsidizationAmount for Relay's sponsorship request, in USDC's own 6-decimal integer units (per Relay's docs: 1000000 = $1). */
export function maxSubsidizationAmountUsdcUnits(chainKey: ChainKey): string {
  const generousUsd = sponsoredFeeFloorUsd(chainKey) * MAX_SUBSIDIZATION_MULTIPLE;
  return String(Math.round(generousUsd * 1_000_000));
}

/**
 * Same contract as appFeeBps(), except when `sponsoringGasOutright` is
 * true: the returned bps is raised (never lowered — appFeeBps()'s own
 * DEV_FEE_MAX_USD cap for large trades is untouched) so the resulting
 * dollar fee never falls below sponsoredFeeFloorUsd() for this chain.
 * With no sponsorship (the default) this is identical to appFeeBps().
 *
 * originAmountUsd is required to compute a floor — without a real trade
 * size there's nothing to raise the rate against, so this silently falls
 * back to the flat rate, same as appFeeBps()'s own no-context behavior
 * (never THROW here: a missing price estimate shouldn't block a quote,
 * it just means this specific protection doesn't apply to it yet).
 */
export function appFeeBpsForSponsoredTrade(
  chainKey: ChainKey,
  originAmountUsd?: number | null,
  options?: {sponsoringGasOutright?: boolean},
): string {
  const baseBps = Number(appFeeBps(originAmountUsd));
  if (!options?.sponsoringGasOutright || !(typeof originAmountUsd === 'number' && originAmountUsd > 0)) {
    return String(baseBps);
  }
  const floorBps = Math.ceil((sponsoredFeeFloorUsd(chainKey) / originAmountUsd) * 10000);
  return String(Math.max(baseBps, floorBps));
}

// Above this, charging enough to cover outright sponsorship stops being
// a "small trade pays a slightly higher %" adjustment and starts being
// "this trade is being charged a double-digit percent fee," which reads
// as broken pricing to a user even though the math is sound. Past this
// point, prefer the structural fix (§1 above: charge gas in the traded
// token via the paymaster) over outright sponsorship for that specific
// trade — this is a signal to the routing layer, not a hard limit
// enforced here.
export const SPONSORED_FEE_BPS_SANITY_CEILING = 300; // 3%

/** True when outright-sponsoring this trade's gas would need a fee so high it should route through pay-gas-in-token instead. */
export function shouldPreferPayGasInToken(chainKey: ChainKey, originAmountUsd?: number | null): boolean {
  if (!(typeof originAmountUsd === 'number' && originAmountUsd > 0)) return false;
  const floorBps = Number(appFeeBpsForSponsoredTrade(chainKey, originAmountUsd, {sponsoringGasOutright: true}));
  return floorBps > SPONSORED_FEE_BPS_SANITY_CEILING;
}

// Relay's own docs are explicit the appFees recipient must always be an
// EVM address, even for a Solana-sourced/destined route — app fees
// accrue off-chain in USDC, claimable on Base, never on the swap's own
// chain. DEV_FEE_WALLET_SOLANA above is intentionally never used as an
// appFees recipient; kept only for documentation/parity with the other
// three repos, which each independently arrived at (and one of them
// briefly regressed away from) the same conclusion.
export function feeRecipientForQuote(): string {
  return DEV_FEE_WALLET;
}

// ---------------------------------------------------------------------
// ONE FEE PER TRADE — even when that trade is a bridge AND a swap at
// once, which is the normal case for Kivo Pro's own token-first flow
// (pay ETH on Base, receive PEPE on Ethereum: origin chain, destination
// chain, AND origin asset, destination asset can all differ in the same
// trade). This is not a hypothetical edge case to design for later — a
// token-first product makes combined bridge+swap trades the common
// path, not the exception.
//
// This is already handled correctly by the existing Relay integration
// this app inherits (mango-bridge.jsx's src/relaybridge.js,
// getRelayQuote()): ONE call takes originChainId/destinationChainId AND
// originCurrency/destinationCurrency together, with exactly ONE appFees
// entry (built from appFeeBps()/appFeeBpsForSponsoredTrade() above) on
// that single call — Relay's own solver handles the bridge-and-swap as
// one atomic route. There are no separate "bridge leg" and "swap leg"
// fees to accidentally add together, because there's no separate bridge
// leg and swap leg to begin with — it's one intent, one quote, one fee.
//
// The failure mode to actively avoid when Kivo Pro's own router.ts
// (build plan §3, not yet built) starts choosing between routes: if it
// ever "manually" decomposes a cross-chain-and-cross-asset trade into
// two sequential calls (bridge via Relay to the destination chain, THEN
// a separate local swap via a DEX aggregator once funds land), each of
// those two calls would independently attach its own fee via this
// file's functions — silently doubling the effective rate charged for
// exactly the trade type this product is built around. Whenever a route
// genuinely does need two provider calls (e.g., a native bridge with no
// built-in swap step, requiring a same-chain swap afterward), compute
// and apply the fee on exactly ONE of the two legs, not both — never
// call appFeeBps()/appFeeBpsForSponsoredTrade() more than once for what
// the user experiences as a single trade.
