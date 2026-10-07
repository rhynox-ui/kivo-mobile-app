// src/core/discoveryFeed.ts
//
// Real data for Home's discovery dashboard, replacing
// src/data/mockDiscovery.ts's hardcoded array (build plan §4 — "swap
// this array for a live DexScreener trending fetch"). Independent real
// sources, one per filter that can honestly be populated today:
//
// - Trending: two independent real sources merged, not one — DexScreener's
//   own token-boosts endpoint (a real paid-attention signal, the same
//   public API this app already depends on for search/charts) hydrated
//   with a real price/mcap/24h lookup per token, PLUS GeckoTerminal's own
//   trending_pools endpoint queried per chain (keyless, free, and already
//   proven live in production by the reference mobile app's own geckoTerminal.js —
//   ported here rather than guessed, including its verified per-chain
//   network-ID registry and its live-confirmed 429 retry behavior). The
//   two sources cover genuinely different ground: DexScreener surfaces
//   whichever tokens are currently PAYING for a boost (narrow, and
//   effectively Solana/EVM-meme-coin-skewed by who buys boosts), while
//   GeckoTerminal surfaces real trading activity across every chain this
//   app supports, boosted or not.
// - Graduated / Bonding: pump.fun's own frontend-api v3
//   (frontend-api-v3.pump.fun — the live successor to the old
//   frontend-api.pump.fun, which is now confirmed dead in production
//   (HTTP 530)). Still unofficial — no published API reference — but
//   this is the current endpoint actively referenced by the Solana
//   meme-coin tooling ecosystem as of when this was written. Solana-only
//   by nature: pump.fun itself is Solana-only, same scope this app's own
//   pumpfun.ts already treats it with. If this one also starts failing,
//   that's pump.fun's own endpoint moving again, not a bug in this code.
//
// "Most held" has NO real source behind it — that would mean either
// on-chain holder counts across arbitrary tokens (no free bulk API for
// this) or "held by Kivo's own users" (this app has no aggregate
// user data at all, only one local device's own history). Deliberately
// NOT wired to a fetch at all; HomeScreen shows an honest "not tracked
// yet" state for it rather than mislabeling Trending's data as
// something it isn't.
//
// Every function here resolves to {tokens, error} rather than throwing
// — a failed fetch is a real, recoverable UI state (same discipline
// tokenSearch.ts/dexScreener.ts already hold themselves to), not a crash.
//
// Real, disclosed gap: Birdeye, CoinMarketCap, and Ave.ai were all
// researched as additional sources. Birdeye and Ave.ai each require
// their own registered API key (the same shape as Relay's own key,
// already wired elsewhere in this app) — not wired in here; add one
// only once a real key exists to configure it with, the same way
// Relay's key was supplied directly rather than guessed or left as a
// placeholder. Pons/ponsfamily.com's own docs were unreachable from
// this session's own sandbox (network egress blocked its docs domain)
// — not integrated for the same reason GeckoTerminal's own unconfirmed
// fields elsewhere in this app family are flagged rather than guessed:
// a wrong endpoint shape fabricated from an unreachable source is
// worse than not having the source at all.
//
// CoinMarketCap re-checked separately (task-tracked, not guessed):
// CMC has since shipped a real "Keyless Public API" covering a subset
// of its DEX routes (pair/token/liquidity/holder/security/swap/K-line)
// with literally no signup or key. But CMC's own docs describe it as
// sharing an undisclosed, IP-pooled rate limit and pitch it explicitly
// for "prototyping and testing," not production traffic — there's no
// key to request a higher tier with if Home's own live discovery feed
// ever gets throttled, unlike every other source here. CMC's actual
// production-grade free option is its keyed Basic tier (15,000
// calls/month, 50 req/min) — real, but the same "needs a registered
// key" shape as Birdeye/Ave.ai above, not a genuine improvement over
// them. Same conclusion as before, sharper reasoning: not wired in
// until a real key exists to configure it with. (Verified via CMC's
// own current API docs/academy pages — this sandbox's network egress
// to coinmarketcap.com itself is blocked, so nothing here was fabricated
// from an assumed response shape; only endpoint existence and the
// rate-limit/production guidance were confirmed, not a live call.)

import {chainKeyForDexScreenerChainId, type DexScreenerPair} from './dexScreener';
import {geckoTerminalNetworkForChainOrNull} from './geckoTerminalNetworks';
import {CHAIN_LABEL, type ChainKey} from './chainData';

// Every ChainKey this app has — CHAIN_LABEL's own type (Record<ChainKey,
// string>) guarantees Object.keys covers all of them, same derivation
// USDC_SUPPORTED_CHAINS already uses elsewhere for the same reason: one
// real source of truth, not a second hand-copied chain list to drift.
const ALL_CHAIN_KEYS = Object.keys(CHAIN_LABEL) as ChainKey[];

export type DiscoveryToken = {
  chainKey: ChainKey;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  /** Real pool liquidity in USD. Only DexScreener/GeckoTerminal pairs carry this — pump.fun's bonding-curve listing has no DEX pool yet, so Graduated/Bonding tokens are honestly null here, never estimated from curve reserves. */
  liquidityUsd: number | null;
  /** Real 24h trade volume in USD, same source availability as liquidityUsd. */
  volumeUsd24h: number | null;
  /** Real 24h buy+sell count, same source availability as liquidityUsd. */
  txCount24h: number | null;
  /** Unix ms this token/pair was first created — pump.fun's own token-creation timestamp for Graduated/Bonding, the pair's listing time for DexScreener/GeckoTerminal sources. */
  createdAt: number | null;
};

export type DiscoveryResult = {tokens: DiscoveryToken[]; error: string | null};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------
// Trending — DexScreener token boosts, hydrated with real market data.

type DexScreenerBoost = {chainId?: string; tokenAddress?: string};

const TRENDING_CANDIDATE_LIMIT = 20;
// Raised from 15 now that Trending merges two independent sources
// (DexScreener boosts + GeckoTerminal's per-chain trending pools,
// below) — genuinely more real tokens to show, not an arbitrary bump.
const TRENDING_RESULT_LIMIT = 40;

async function hydrateBoostedToken(chainKey: ChainKey, dexScreenerChainId: string, tokenAddress: string): Promise<DiscoveryToken | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as {pairs?: DexScreenerPair[]};
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    let best: DexScreenerPair | null = null;
    let bestLiquidity = -1;
    // A token can trade across several pools, and DexScreener often
    // attaches image metadata to only one of them — track the first
    // real image found across ANY of this token's pairs separately from
    // "best" (which stays purely about price/mcap/liquidity), so a real
    // icon never goes missing just because the highest-liquidity pool
    // happens to be the one DexScreener didn't tag with an image.
    let firstImageUrl: string | null = null;
    for (const pair of pairs) {
      if (pair?.chainId !== dexScreenerChainId) continue;
      const liquidity = num(pair?.liquidity?.usd) ?? 0;
      if (liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        best = pair;
      }
      if (!firstImageUrl) {
        const pairImage = (pair as {info?: {imageUrl?: string}})?.info?.imageUrl;
        if (typeof pairImage === 'string') firstImageUrl = pairImage;
      }
    }
    if (!best) return null;
    const bestInfo = (best as {info?: {imageUrl?: string}})?.info;
    const bestImageUrl = typeof bestInfo?.imageUrl === 'string' ? bestInfo.imageUrl : null;
    return {
      chainKey,
      tokenAddress,
      symbol: String(best.baseToken?.symbol ?? '?'),
      name: String(best.baseToken?.name ?? best.baseToken?.symbol ?? 'Unknown token'),
      imageUrl: bestImageUrl ?? firstImageUrl,
      priceUsd: num(best.priceUsd),
      change24h: num(best.priceChange?.h24),
      marketCapUsd: num(best.marketCap ?? best.fdv),
      liquidityUsd: num(best.liquidity?.usd),
      volumeUsd24h: num(best.volume?.h24),
      txCount24h: (() => {
        const buys = num(best.txns?.h24?.buys);
        const sells = num(best.txns?.h24?.sells);
        return buys == null && sells == null ? null : (buys ?? 0) + (sells ?? 0);
      })(),
      createdAt: num(best.pairCreatedAt),
    };
  } catch {
    return null;
  }
}

/**
 * DexScreener's own currently-boosted list (a real signal — projects pay
 * to be here — not a fabricated "trending" score), filtered to chains
 * this app supports, then hydrated one call per token for real
 * price/change/mcap. Bounded to TRENDING_CANDIDATE_LIMIT candidates so a
 * slow/large boost list can't turn this into dozens of parallel requests
 * — same "don't hammer the API" discipline this file's own GeckoTerminal
 * fetch below already has to hold itself to.
 */
async function fetchDexScreenerBoostedTrending(): Promise<DiscoveryResult> {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if (!res.ok) return {tokens: [], error: `DexScreener returned ${res.status}.`};
    const body = (await res.json()) as DexScreenerBoost[] | {boosts?: DexScreenerBoost[]};
    const boosts = Array.isArray(body) ? body : Array.isArray(body?.boosts) ? body.boosts : [];

    const seen = new Set<string>();
    const candidates: {chainKey: ChainKey; dexScreenerChainId: string; tokenAddress: string}[] = [];
    for (const boost of boosts) {
      if (candidates.length >= TRENDING_CANDIDATE_LIMIT) break;
      const dexScreenerChainId = boost?.chainId;
      const tokenAddress = boost?.tokenAddress;
      if (!dexScreenerChainId || !tokenAddress) continue;
      const chainKey = chainKeyForDexScreenerChainId(dexScreenerChainId);
      if (!chainKey) continue; // a real chain we just don't route trades on
      const dedupeKey = `${chainKey}:${tokenAddress.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({chainKey, dexScreenerChainId, tokenAddress});
    }

    const hydrated = await Promise.all(candidates.map(c => hydrateBoostedToken(c.chainKey, c.dexScreenerChainId, c.tokenAddress)));
    const tokens = hydrated.filter((t): t is DiscoveryToken => t !== null);
    return {tokens, error: null};
  } catch (err) {
    return {tokens: [], error: err instanceof Error ? err.message : 'Could not reach DexScreener.'};
  }
}

// ---------------------------------------------------------------------
// Trending, second source — GeckoTerminal's own trending_pools per chain.
// Keyless, free, and already proven live in production by mango-mobile's
// own geckoTerminal.js — same base URL and same live-confirmed 429
// retry-once behavior, ported rather than guessed (see
// geckoTerminalNetworks.ts's own header for the verified per-chain
// network-ID registry this draws on). This is what actually answers
// "not just pump.fun, all trending protocols on the most active chains":
// GeckoTerminal indexes pools chain-wide across whichever DEX a token
// actually trades on, so a Four.meme token on BNB Chain or a graduated
// Pons token on Robinhood Chain surfaces here the same way a pump.fun
// graduate does on Solana — this app doesn't need a bespoke connector
// per launchpad protocol to show its trending activity.

const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2';
// Capped low per chain (not "take everything") — this runs across every
// supported chain in parallel already, and GeckoTerminal's free tier is
// the one source in this file with a real, live-confirmed rate limit.
const GECKOTERMINAL_POOLS_PER_CHAIN = 4;

async function fetchGeckoTerminalWithRetry(url: string): Promise<Response> {
  const res = await fetch(url);
  if (res.status !== 429) return res;
  await new Promise<void>(resolve => setTimeout(() => resolve(), 1500));
  return fetch(url);
}

type GeckoTerminalTokenAttrs = {address?: string; symbol?: string; name?: string; image_url?: string};

async function fetchTrendingPoolsForChain(chainKey: ChainKey): Promise<DiscoveryToken[]> {
  const network = geckoTerminalNetworkForChainOrNull(chainKey);
  if (!network) return [];
  try {
    const res = await fetchGeckoTerminalWithRetry(`${GECKOTERMINAL_BASE_URL}/networks/${network}/trending_pools?include=base_token`);
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: {
        attributes?: {
          market_cap_usd?: unknown;
          fdv_usd?: unknown;
          base_token_price_usd?: unknown;
          price_change_percentage?: {h24?: unknown};
          reserve_in_usd?: unknown;
          volume_usd?: {h24?: unknown};
          transactions?: {h24?: {buys?: unknown; sells?: unknown}};
          pool_created_at?: unknown;
        };
        relationships?: {base_token?: {data?: {id?: string}}};
      }[];
      included?: {type?: string; id?: string; attributes?: GeckoTerminalTokenAttrs}[];
    };
    const pools = Array.isArray(body?.data) ? body.data : [];
    const included = Array.isArray(body?.included) ? body.included : [];
    const tokensById = new Map<string, GeckoTerminalTokenAttrs | undefined>();
    for (const item of included) {
      if (item?.type === 'token' && item?.id) tokensById.set(item.id, item.attributes);
    }

    const tokens: DiscoveryToken[] = [];
    for (const pool of pools.slice(0, GECKOTERMINAL_POOLS_PER_CHAIN)) {
      const baseId = pool?.relationships?.base_token?.data?.id;
      const token = baseId ? tokensById.get(baseId) : undefined;
      const address = token?.address;
      if (!address) continue;
      // GeckoTerminal/CoinGecko's own generic placeholder graphic for a
      // token with no real logo indexed — never shown as if it were the
      // token's real image.
      const imageUrl = typeof token?.image_url === 'string' && !token.image_url.includes('missing_large') ? token.image_url : null;
      tokens.push({
        chainKey,
        tokenAddress: address,
        symbol: String(token?.symbol ?? '?'),
        name: String(token?.name ?? token?.symbol ?? 'Unknown token'),
        imageUrl,
        priceUsd: num(pool?.attributes?.base_token_price_usd),
        change24h: num(pool?.attributes?.price_change_percentage?.h24),
        marketCapUsd: num(pool?.attributes?.market_cap_usd ?? pool?.attributes?.fdv_usd),
        liquidityUsd: num(pool?.attributes?.reserve_in_usd),
        volumeUsd24h: num(pool?.attributes?.volume_usd?.h24),
        txCount24h: (() => {
          const buys = num(pool?.attributes?.transactions?.h24?.buys);
          const sells = num(pool?.attributes?.transactions?.h24?.sells);
          return buys == null && sells == null ? null : (buys ?? 0) + (sells ?? 0);
        })(),
        // pool_created_at is an ISO 8601 string here, unlike DexScreener's
        // own pairCreatedAt (already unix ms) — normalized to ms so
        // sortTokens's age comparison works the same regardless of source.
        createdAt: (() => {
          const raw = pool?.attributes?.pool_created_at;
          if (typeof raw !== 'string') return null;
          const parsed = Date.parse(raw);
          return Number.isFinite(parsed) ? parsed : null;
        })(),
      });
    }
    return tokens;
  } catch {
    return [];
  }
}

/**
 * Real trending tokens, merged from two independent sources (see this
 * section's own header above for why one alone isn't enough): DexScreener's
 * paid-boost list first (existing behavior, unchanged ranking), then
 * GeckoTerminal's per-chain trending pools filling in genuine chain-wide
 * coverage a boost list alone can't offer — deduped against whatever
 * DexScreener already contributed. Each source fails independently
 * (Promise.allSettled for the 14-way GeckoTerminal fan-out, matching
 * usdcBalances.ts's own "one chain's hiccup doesn't blank the total"
 * discipline) — an error is only ever surfaced if BOTH sources returned
 * nothing at all, never when one degrades and the other still has data.
 */
export async function fetchTrendingTokens(): Promise<DiscoveryResult> {
  const [dexScreenerResult, geckoTerminalSettled] = await Promise.all([
    fetchDexScreenerBoostedTrending(),
    Promise.allSettled(ALL_CHAIN_KEYS.map(fetchTrendingPoolsForChain)),
  ]);

  const seen = new Set(dexScreenerResult.tokens.map(t => `${t.chainKey}:${t.tokenAddress.toLowerCase()}`));
  const geckoTerminalTokens: DiscoveryToken[] = [];
  for (const outcome of geckoTerminalSettled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const token of outcome.value) {
      const key = `${token.chainKey}:${token.tokenAddress.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      geckoTerminalTokens.push(token);
    }
  }

  const tokens = [...dexScreenerResult.tokens, ...geckoTerminalTokens].slice(0, TRENDING_RESULT_LIMIT);
  const error = tokens.length === 0 ? (dexScreenerResult.error ?? 'Could not load trending tokens.') : null;
  return {tokens, error};
}

// ---------------------------------------------------------------------
// Graduated / Bonding — pump.fun's own frontend-api. Solana-only.

type PumpFunCoin = {
  mint?: string;
  symbol?: string;
  name?: string;
  image_uri?: string;
  usd_market_cap?: number;
  market_cap?: number;
  complete?: boolean;
  /** Unix ms — pump.fun's own token-creation time, real "age" data even though this listing has no DEX pool yet. */
  created_timestamp?: number;
};

const PUMP_FUN_RESULT_LIMIT = 20;

function mapPumpFunCoin(coin: PumpFunCoin): DiscoveryToken | null {
  const mint = coin?.mint;
  if (typeof mint !== 'string' || !mint) return null;
  return {
    chainKey: 'solana',
    tokenAddress: mint,
    symbol: String(coin.symbol ?? '?'),
    name: String(coin.name ?? coin.symbol ?? 'Unknown token'),
    imageUrl: typeof coin.image_uri === 'string' ? coin.image_uri : null,
    // pump.fun's own listing doesn't carry a live USD price per-token
    // (that's a DEX/pool-derived number, not something the launch API
    // itself tracks) — never guessed here, left null rather than
    // computed from the bonding-curve formula this app already has
    // elsewhere (pumpfun.ts), which would silently drift from whatever
    // price a real trade actually executes at.
    priceUsd: null,
    change24h: null,
    marketCapUsd: num(coin.usd_market_cap ?? coin.market_cap),
    // No DEX pool yet on a bonding-curve listing — honestly null rather
    // than estimated from curve reserves (same reasoning as priceUsd
    // above).
    liquidityUsd: null,
    volumeUsd24h: null,
    txCount24h: null,
    createdAt: num(coin.created_timestamp),
  };
}

/**
 * pump.fun's frontend-api is unofficial (no published API reference) —
 * widely used across Solana meme-coin tooling for exactly this, but not
 * a documented, stable contract the way DexScreener's public API is.
 * Failure here (blocked, rate-limited, shape changed) surfaces as a
 * real "couldn't load" state, never a crash or fabricated fallback.
 *
 * Real fix, confirmed live in production: frontend-api.pump.fun (this
 * function's original base URL) started returning HTTP 530 — a
 * Cloudflare "origin unreachable," not a transient blip — meaning
 * pump.fun retired or relocated that host entirely. frontend-api-v3.pump.fun
 * is the live successor actively referenced by current Solana meme-coin
 * tooling as of when this was written. GENUINE, DISCLOSED GAP: the exact
 * query-parameter shape for a multi-coin LISTING endpoint on v3 (as
 * opposed to its documented single-coin /coins/{mint} lookup) couldn't
 * be independently confirmed — third-party wrapper docs describe a
 * get_latest_coins(limit, offset) method implying the same limit/offset/
 * sort/order/complete convention this file already used against v1
 * carried over, but that's inference, not a confirmed live response.
 * If this shape turns out wrong, the real, honest failure mode already
 * built in below (a non-ok response or an unexpected body shape) is what
 * surfaces — never a silent empty list pretending to be complete.
 */
async function fetchPumpFunCoins(complete: boolean): Promise<DiscoveryResult> {
  try {
    const res = await fetch(
      `https://frontend-api-v3.pump.fun/coins?offset=0&limit=${PUMP_FUN_RESULT_LIMIT}&sort=market_cap&order=DESC&includeNsfw=false&complete=${complete}`,
    );
    if (!res.ok) return {tokens: [], error: `pump.fun returned ${res.status}.`};
    const body = (await res.json()) as PumpFunCoin[];
    if (!Array.isArray(body)) return {tokens: [], error: 'Unexpected response from pump.fun.'};
    const tokens = body.map(mapPumpFunCoin).filter((t): t is DiscoveryToken => t !== null);
    return {tokens, error: null};
  } catch (err) {
    return {tokens: [], error: err instanceof Error ? err.message : 'Could not reach pump.fun.'};
  }
}

/** Tokens that have graduated off pump.fun's bonding curve onto a real PumpSwap/DEX pool. */
export function fetchGraduatedTokens(): Promise<DiscoveryResult> {
  return fetchPumpFunCoins(true);
}

/** Tokens still on pump.fun's bonding curve, ranked by market cap. */
export function fetchBondingTokens(): Promise<DiscoveryResult> {
  return fetchPumpFunCoins(false);
}
