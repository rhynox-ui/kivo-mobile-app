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

import {ARC_USDC, NEAR_USDC, TOKEN_ADDRESSES, type ChainKey} from './chainData.ts';

// Kivo's own fee wallets (set by the Kivo owner).
export const DEV_FEE_WALLET = '0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5';
export const DEV_FEE_WALLET_SOLANA = '2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';
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

// ---------------------------------------------------------------------
// KIVO'S TRADING FEE — the "full FOMO model" (owner decision).
//
//   pct = 0.5%, or 0.45% for a user who joined through a referral.
//
//   - Solana trades (Kivo pays the Solana network fee):
//       fee = max(pct x amount, min(2% x amount, $0.95))
//     $10 -> $0.20, $25 -> $0.50, $50 -> $0.95, $100 -> $0.95,
//     $190 -> $0.95, $250 -> $1.25, $500 -> $2.50, $1000 -> $5.00.
//     The 2% and $0.95 parts are the same for referred users.
//   - Every other chain (Base, BNB, Ethereum, Arbitrum, NEAR, ...):
//       fee = pct x amount
//   - Blue chips (SOL/wSOL, ETH/WETH, WBTC/cbBTC/BTCB, BNB/WBNB) on any
//     chain: 0.05% (0.045% referred), no minimum.
//   - Every fee is capped at DEV_FEE_MAX_USD ($50) per trade.
//
// kivoFeeUsd() is the ONE place this is computed; kivoFeeBps() is derived
// from it for bps-shaped fee APIs (Relay, 1Click, aggregators). Every route
// passes the trade's chain and the token being bought or sold (never the
// USDC/pay side) — see feeTokenForTrade() for routes that only know both
// sides of a swap.

export const DEV_FEE_PCT = 0.005;
export const DEV_FEE_MAX_USD = 50;
/** Referred users pay 10% less, for life: 0.45% instead of 0.50% (same $50 cap). */
export const REFERRAL_FEE_PCT = 0.0045;
/** Blue-chip trades: 0.05% (0.045% referred), no minimum, any chain. */
export const BLUE_CHIP_FEE_PCT = 0.0005;
export const REFERRAL_BLUE_CHIP_FEE_PCT = 0.00045;
/** Solana minimum: min(2% of the trade, $0.95). Never discounted. */
export const SOLANA_MIN_FEE_PCT = 0.02;
export const SOLANA_MIN_FEE_USD = 0.95;
/** Most Kivo ever asks one trade to pay, in bps (matches the server's ceiling). */
export const MAX_KIVO_FEE_BPS = 500;

/**
 * Smallest trade the mobile app accepts, in USD. On Solana the fee is at
 * least min(2%, $0.95); elsewhere it is a percent of the trade (capped at
 * $50). The server drops gas sponsorship that would cost Kivo more than the
 * fee a trade pays, so no trade runs at a loss.
 */
export const MIN_TRADE_USD = 2;

let referralDiscount = false;

/**
 * Turn the referral discount on for this signed-in user. Clients call it with
 * `me.feeBps === 45` after loading /api/referrals/me (sign-in / app start) and
 * after a successful referral claim. Off by default and after sign-out.
 */
export function setReferralFeeDiscount(on: boolean): void {
  referralDiscount = on === true;
}

/** True while this signed-in user has the referral discount. */
export function hasReferralFeeDiscount(): boolean {
  return referralDiscount;
}

/** A trade's chain: a Relay chain, NEAR, or anything else (treated as "other chains"). */
export type FeeChain = ChainKey | 'near';

const EVM_NATIVE = ['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
const CBBTC_EVM = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const OP_STACK_WETH = '0x4200000000000000000000000000000000000006';

/**
 * Blue-chip tokens per chain: one explicit list, nothing inferred from a
 * symbol (anyone can deploy a token called "WETH"). Native ETH/BNB/SOL is
 * listed by the placeholder address Kivo's routes use for it. A Record so a
 * new ChainKey has to decide its list here.
 */
export const BLUE_CHIP_TOKENS: Record<ChainKey, readonly string[]> = {
  solana: [
    '11111111111111111111111111111111', // native SOL (Relay's placeholder)
    'So11111111111111111111111111111111111111112', // wSOL
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Wormhole)
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Wormhole)
  ],
  ethereum: [
    ...EVM_NATIVE, // ETH
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    TOKEN_ADDRESSES.WBTC?.ethereum ?? '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    CBBTC_EVM, // cbBTC
    '0xB8c77482e45F1F44dE1745F52C74426C631bDD52', // BNB (ERC-20)
  ],
  base: [
    ...EVM_NATIVE, // ETH
    OP_STACK_WETH, // WETH
    TOKEN_ADDRESSES.WBTC?.base ?? '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', // WBTC
    CBBTC_EVM, // cbBTC
  ],
  arbitrum: [
    ...EVM_NATIVE, // ETH
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
    CBBTC_EVM, // cbBTC
  ],
  bnb: [
    ...EVM_NATIVE, // BNB
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH (Binance-Peg)
  ],
  avalanche: [
    '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH.e
    '0x50b7545627a5162F82A992c33b87aDc75187B218', // WBTC.e
    '0x152b9d0FdC40C096757F570A51E494bd4b943E50', // BTC.b
  ],
  unichain: [...EVM_NATIVE, OP_STACK_WETH], // ETH, WETH
  ink: [...EVM_NATIVE, OP_STACK_WETH], // ETH, WETH
  robinhood: [...EVM_NATIVE], // ETH
  abstract: [...EVM_NATIVE], // ETH
  // Native coins here are not blue chips (USDT0, HYPE, XPL, OKB, USDC).
  stable: [],
  hyperevm: [],
  plasma: [],
  xlayer: [],
  arc: [],
};

/** EVM addresses compare case-insensitively; Solana/NEAR ids are case-sensitive. */
function sameToken(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const BLUE_CHIP_LOOKUP: Partial<Record<ChainKey, Set<string>>> = Object.fromEntries(
  (Object.keys(BLUE_CHIP_TOKENS) as ChainKey[]).map(chain => [chain, new Set(BLUE_CHIP_TOKENS[chain].map(a => (/^0x/i.test(a) ? a.toLowerCase() : a)))]),
);

/** True when `tokenAddress` is one of BLUE_CHIP_TOKENS on `chainKey`. */
export function isBlueChip(chainKey: FeeChain | string | null | undefined, tokenAddress: string | null | undefined): boolean {
  if (!chainKey || typeof tokenAddress !== 'string' || !tokenAddress.trim()) return false;
  const set = BLUE_CHIP_LOOKUP[chainKey as ChainKey];
  if (!set) return false;
  const t = tokenAddress.trim();
  return set.has(/^0x[0-9a-fA-F]{40}$/.test(t) ? t.toLowerCase() : t);
}

/** True for a dollar stablecoin Kivo pays/receives with (USDC, USDT, USDT0, USDG), including Stable/Arc's native USD coin. */
export function isStableToken(chainKey: FeeChain | string | null | undefined, tokenAddress: string | null | undefined): boolean {
  if (!chainKey || typeof tokenAddress !== 'string' || !tokenAddress.trim()) return false;
  if (chainKey === 'near') return sameToken(tokenAddress, NEAR_USDC);
  if ((chainKey === 'stable' || chainKey === 'arc') && EVM_NATIVE.some(a => sameToken(tokenAddress, a))) return true;
  if (chainKey === 'arc' && sameToken(tokenAddress, ARC_USDC)) return true;
  for (const symbol of ['USDC', 'USDT', 'USDT0', 'USDG']) {
    const address = TOKEN_ADDRESSES[symbol]?.[chainKey as ChainKey];
    if (address && sameToken(tokenAddress, address)) return true;
  }
  return false;
}

export type FeeToken = {chainKey: FeeChain | string | null | undefined; tokenAddress: string | null | undefined};

/**
 * The token a trade's fee is classified by, when a route only knows both
 * sides of a swap (Relay, aggregators): the side that is not the USDC/pay
 * side. Selling a memecoin for ETH is classified by the memecoin, not by
 * ETH. Cross-chain (Relay): the chain of that token. When both or neither
 * side is a stablecoin/blue chip, the side being bought.
 */
export function feeTokenForTrade(from: FeeToken, to: FeeToken): FeeToken {
  const fromStable = isStableToken(from.chainKey, from.tokenAddress);
  const toStable = isStableToken(to.chainKey, to.tokenAddress);
  if (toStable && !fromStable) return from;
  if (fromStable && !toStable) return to;
  const fromBlue = isBlueChip(from.chainKey, from.tokenAddress);
  const toBlue = isBlueChip(to.chainKey, to.tokenAddress);
  if (toBlue && !fromBlue) return from;
  return to;
}

export type KivoFeeInput = {
  /** USD size of the trade. */
  amountUsd?: number | null;
  /** Chain of the token being bought or sold. */
  chainKey?: FeeChain | string | null;
  /** The token being bought or sold (not the USDC/pay side). */
  tokenAddress?: string | null;
  /** Overrides the signed-in user's referral flag (tests, server checks). */
  referred?: boolean;
};

/** The percentage part of this trade's fee (before the Solana minimum and the $50 cap). */
export function kivoFeePct(input: KivoFeeInput): number {
  const referred = input.referred ?? referralDiscount;
  if (isBlueChip(input.chainKey, input.tokenAddress)) return referred ? REFERRAL_BLUE_CHIP_FEE_PCT : BLUE_CHIP_FEE_PCT;
  return referred ? REFERRAL_FEE_PCT : DEV_FEE_PCT;
}

/**
 * Kivo's fee for one trade, in USD. 0 when the trade size is unknown or not
 * positive. See this section's header for the model.
 */
export function kivoFeeUsd(input: KivoFeeInput): number {
  const amount = input.amountUsd;
  if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0)) return 0;
  const pct = kivoFeePct(input);
  let fee = amount * pct;
  if (input.chainKey === 'solana' && !isBlueChip(input.chainKey, input.tokenAddress)) {
    fee = Math.max(fee, Math.min(amount * SOLANA_MIN_FEE_PCT, SOLANA_MIN_FEE_USD));
  }
  return Math.min(fee, DEV_FEE_MAX_USD);
}

/**
 * kivoFeeUsd() as whole bps of amountUsd, for bps-shaped fee APIs. Rounded
 * down (never charges more than kivoFeeUsd), at least 1 while a fee is due,
 * never above MAX_KIVO_FEE_BPS. Without a real trade size this is the
 * percentage rate alone (the Solana minimum needs a size to apply).
 */
export function kivoFeeBps(input: KivoFeeInput): string {
  const amount = input.amountUsd;
  const sized = typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  const ratio = sized ? kivoFeeUsd(input) / amount : kivoFeePct(input);
  const bps = Math.floor(ratio * 10_000 + 1e-6);
  return String(Math.min(MAX_KIVO_FEE_BPS, Math.max(1, bps)));
}

function trimNumber(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}

/** "$0.95 (1.9%)": Kivo's fee in dollars and as a percent of the trade, for quote/confirm screens. */
export function formatKivoFee(feeUsd: number | null | undefined, amountUsd: number | null | undefined): string {
  if (!(typeof feeUsd === 'number' && Number.isFinite(feeUsd) && feeUsd >= 0)) return '—';
  const dollars = feeUsd === 0 ? '$0' : feeUsd < 0.01 ? '<$0.01' : `$${feeUsd.toFixed(2)}`;
  if (!(typeof amountUsd === 'number' && Number.isFinite(amountUsd) && amountUsd > 0)) return dollars;
  const pct = (feeUsd / amountUsd) * 100;
  const shown = pct >= 1 ? trimNumber(pct, 1) : pct >= 0.1 ? trimNumber(pct, 2) : trimNumber(pct, 3);
  return `${dollars} (${shown || '0'}%)`;
}

// ---------------------------------------------------------------------
// Chain-aware fee floor for sponsored gas.
//
// The base fee above (kivoFeeUsd) is pure margin math — correct as long as gas is
// the USER's own cost (mobile/site/bot: they hold native gas and pay it
// themselves). Kivo Pro's whole premise is gas SPONSORSHIP (a paymaster
// or fee-payer covers gas so the user doesn't need native tokens — build
// plan §1/§6), which turns gas into a real, chain-dependent cost the
// PROTOCOL eats. The base fee is fine on Solana/Base/most L2s, where
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
 * Same contract as kivoFeeBps(), except when `sponsoringGasOutright` is
 * true: the returned bps is raised (never lowered — kivoFeeBps()'s own
 * DEV_FEE_MAX_USD cap for large trades is untouched) so the resulting
 * dollar fee never falls below sponsoredFeeFloorUsd() for this chain,
 * and never above MAX_KIVO_FEE_BPS. With no sponsorship (the default)
 * this is identical to kivoFeeBps() for the same chain and token.
 *
 * originAmountUsd is required to compute a floor — without a real trade
 * size there's nothing to raise the rate against, so this silently falls
 * back to the base rate, same as kivoFeeBps()'s own no-context behavior
 * (never THROW here: a missing price estimate shouldn't block a quote,
 * it just means this specific protection doesn't apply to it yet).
 */
export function appFeeBpsForSponsoredTrade(
  chainKey: ChainKey,
  originAmountUsd?: number | null,
  options?: {sponsoringGasOutright?: boolean; tokenAddress?: string | null},
): string {
  const baseBps = Number(kivoFeeBps({amountUsd: originAmountUsd, chainKey, tokenAddress: options?.tokenAddress}));
  if (!options?.sponsoringGasOutright || !(typeof originAmountUsd === 'number' && originAmountUsd > 0)) {
    return String(baseBps);
  }
  const floorBps = Math.ceil((sponsoredFeeFloorUsd(chainKey) / originAmountUsd) * 10000);
  return String(Math.min(MAX_KIVO_FEE_BPS, Math.max(baseBps, floorBps)));
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
export function shouldPreferPayGasInToken(chainKey: ChainKey, originAmountUsd?: number | null, tokenAddress?: string | null): boolean {
  if (!(typeof originAmountUsd === 'number' && originAmountUsd > 0)) return false;
  const floorBps = Math.ceil((sponsoredFeeFloorUsd(chainKey) / originAmountUsd) * 10000);
  const baseBps = Number(kivoFeeBps({amountUsd: originAmountUsd, chainKey, tokenAddress}));
  return Math.max(baseBps, floorBps) > SPONSORED_FEE_BPS_SANITY_CEILING;
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
// entry (built from kivoFeeBps()/appFeeBpsForSponsoredTrade() above) on
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
// call kivoFeeBps()/appFeeBpsForSponsoredTrade() more than once for what
// the user experiences as a single trade.
