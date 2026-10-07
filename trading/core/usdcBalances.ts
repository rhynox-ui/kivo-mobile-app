// src/core/usdcBalances.ts
//
// Aggregates a wallet's USDC balance across every chain this app has a
// verified USDC address for — the concrete answer to "can deposits be
// accepted on all chains we trade on, not just one default chain": yes,
// and this is what makes that a real number instead of a UI promise.
//
// The chain list is derived FROM chainData.ts's own TOKEN_ADDRESSES.USDC
// (Object.keys), not duplicated here — adding USDC support for a new
// chain in chainData.ts is the only edit needed for it to show up here
// too, same "one source of truth" discipline chainData.ts's own header
// already asks for.
//
// Uses Promise.allSettled deliberately, not Promise.all: one chain's RPC
// hiccup must not blank the whole total for a user who has real USDC on
// four other chains. Callers get both the best-effort sum AND which
// chains failed, so a partial result can be shown as partial — never
// silently presented as complete when it isn't.

import {TOKEN_ADDRESSES, ASSET_ONCHAIN_DECIMALS, assetDecimalsForChain, NEAR_ENABLED, NEAR_USDC, NEAR_USDC_DECIMALS, type ChainKey} from './chainData.ts';
import {nearView} from './nearRpc.ts';
import {fetchWalletSplTokenBalance, fetchWalletTokenBalance} from '../wallet/walletRpc.ts';
import type {DerivedAccounts} from '../wallet/keys';

// Real caching gap this closes: every one of these fans out to ALL of
// USDC_SUPPORTED_CHAINS/CASH_SUPPORTED_CHAINS (~10 RPC calls) on every
// single call — and HomeScreen, ProfileScreen, and TokenTradeScreen each
// independently call one of these on their own mount, so switching
// Home -> Trade -> Profile in normal use re-ran the full ~10-chain fan-
// out three times in as many seconds for a number that hadn't changed.
// walletRpc.ts already caches each INDIVIDUAL chain's balance (45s), but
// that only helps once a chain has actually SUCCEEDED once — a chain
// that's currently failing (the live, repeatedly-observed
// "Couldn't load balance" case) is never cached there and gets retried
// at full frequency on every single one of these three screens' visits.
// This cache sits one level up: the WHOLE portfolio result, success or
// partial failure alike, reused for a short window across all callers.
// Session-scoped (not per-address-in-isolation) since a portfolio reads
// both the EVM and Solana address together; forceFresh is the deliberate
// bypass for the two places that need a truly current number right now
// (ProfileScreen's pull-to-refresh and its post-Convert refresh).
const PORTFOLIO_CACHE_TTL_MS = 30_000;
// Arc pays transaction gas from its native USDC balance; keep a small reserve so Max/Buy never drains the wallet completely.
export const ARC_GAS_RESERVE_USDC = 0.01;

function sessionCacheKey(session: DerivedAccounts): string {
  return `${session.evm.address.toLowerCase()}:${session.solana.address}`;
}

function makePortfolioCache<T>() {
  let cached: {key: string; data: T; fetchedAt: number} | null = null;
  let inFlight: {key: string; promise: Promise<T>} | null = null;
  return {
    get(key: string): T | null {
      if (cached && cached.key === key && Date.now() - cached.fetchedAt < PORTFOLIO_CACHE_TTL_MS) return cached.data;
      return null;
    },
    getInFlight(key: string): Promise<T> | null {
      return inFlight && inFlight.key === key ? inFlight.promise : null;
    },
    run(key: string, fetcher: () => Promise<T>): Promise<T> {
      const promise = fetcher().then(data => {
        cached = {key, data, fetchedAt: Date.now()};
        return data;
      });
      inFlight = {key, promise};
      promise.finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      return promise;
    },
  };
}

/** Every chain this app has a verified USDC contract/mint address for — see this file's own header for why this is derived, not a separate hardcoded list. */
export const USDC_SUPPORTED_CHAINS = Object.keys(TOKEN_ADDRESSES.USDC ?? {}) as ChainKey[];

export type ChainUsdcResult = {chainKey: ChainKey; status: 'ok'; balance: number} | {chainKey: ChainKey; status: 'error'; error: string};

/** USDC on NEAR — beside the ChainKey results, since NEAR isn't a Relay chain (chainData.ts's NEAR note). */
export type NearCashResult = {status: 'ok'; balance: number} | {status: 'error'; error: string};

/** USDC held by a NEAR account (ft_balance_of on NEAR's native USDC contract), in whole USDC. */
export async function fetchNearUsdcBalance(accountId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const raw = await nearView<string | null>(NEAR_USDC, 'ft_balance_of', {account_id: accountId}, undefined, fetchImpl);
  const units = BigInt(typeof raw === 'string' && /^\d+$/.test(raw) ? raw : '0');
  const scale = 10n ** BigInt(NEAR_USDC_DECIMALS);
  return Number(units / scale) + Number(units % scale) / Number(scale);
}

/** null while NEAR is switched off or the session has no NEAR account (a Google session). */
async function nearCashFor(session: DerivedAccounts, fetchImpl: typeof fetch = fetch): Promise<NearCashResult | null> {
  if (!NEAR_ENABLED || !session.near) return null;
  try {
    return {status: 'ok', balance: await fetchNearUsdcBalance(session.near.address, fetchImpl)};
  } catch (e) {
    return {status: 'error', error: e instanceof Error ? e.message : "Could not fetch the NEAR balance."};
  }
}

/** Adds NEAR's USDC into a portfolio's total and completeness. */
export function withNearCash<T extends {totalUsd: number; complete: boolean}>(portfolio: T, near: NearCashResult | null): T & {near: NearCashResult | null} {
  if (!near) return {...portfolio, near: null};
  return {
    ...portfolio,
    near,
    totalUsd: portfolio.totalUsd + (near.status === 'ok' ? near.balance : 0),
    complete: portfolio.complete && near.status === 'ok',
  };
}

export type UsdcPortfolio = {
  results: ChainUsdcResult[];
  /** USDC on NEAR (null when NEAR is off / no NEAR account) — already included in totalUsd. */
  near?: NearCashResult | null;
  totalUsd: number;
  /** True when every chain answered — false means totalUsd is a real but INCOMPLETE sum, not the user's actual total. */
  complete: boolean;
};

async function fetchOneChainUsdc(chainKey: ChainKey, session: DerivedAccounts): Promise<number> {
  const address = TOKEN_ADDRESSES.USDC[chainKey];
  if (!address) throw new Error(`No verified USDC address for ${chainKey}.`);
  // Real bug this fixes: BNB Chain's own USDC contract uses 18 decimals,
  // not the usual 6 (chainData.ts's own ASSET_ONCHAIN_DECIMALS_BY_CHAIN
  // override) — reading it as 6 would misreport the balance by a factor
  // of 10^12. assetDecimalsForChain already knows this per chain; a flat
  // ASSET_ONCHAIN_DECIMALS.USDC constant here silently ignored it.
  const decimals = assetDecimalsForChain(chainKey, 'USDC') ?? ASSET_ONCHAIN_DECIMALS.USDC;
  if (chainKey === 'solana') {
    return fetchWalletSplTokenBalance(address, decimals, session.solana.address);
  }
  return fetchWalletTokenBalance(chainKey, address, decimals, session.evm.address);
}

const usdcPortfolioCache = makePortfolioCache<UsdcPortfolio>();

export async function fetchUsdcPortfolio(session: DerivedAccounts, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<UsdcPortfolio> {
  const key = sessionCacheKey(session);
  if (!forceFresh) {
    const cached = usdcPortfolioCache.get(key);
    if (cached) return cached;
    const inFlight = usdcPortfolioCache.getInFlight(key);
    if (inFlight) return inFlight;
  }
  return usdcPortfolioCache.run(key, async () => {
    const [settled, near] = await Promise.all([Promise.allSettled(USDC_SUPPORTED_CHAINS.map(chainKey => fetchOneChainUsdc(chainKey, session))), nearCashFor(session)]);

    const results: ChainUsdcResult[] = settled.map((outcome, i) => {
      const chainKey = USDC_SUPPORTED_CHAINS[i];
      if (outcome.status === 'fulfilled') {
        return {chainKey, status: 'ok', balance: outcome.value};
      }
      const error = outcome.reason instanceof Error ? outcome.reason.message : 'Could not fetch this chain\'s balance.';
      return {chainKey, status: 'error', error};
    });

    const totalUsd = results.reduce((sum, r) => (r.status === 'ok' ? sum + r.balance : sum), 0);
    const complete = results.every(r => r.status === 'ok');

    return withNearCash({results, totalUsd, complete}, near);
  });
}

// Real per-chain "cash" asset — USDC everywhere it exists, USDG on
// Robinhood Chain (its own real, native stablecoin; there is no USDC
// contract there at all — see chainData.ts's own header on why). This
// is the deliberate "USDC everywhere, except where the real asset is
// different" model FOMO's own reference behavior uses (confirmed via
// research, not guessed: FOMO lets users deposit/withdraw real USDG on
// Robinhood Chain and folds it into the same one-balance total).
//
// USDC_SUPPORTED_CHAINS/fetchUsdcPortfolio above stay UNCHANGED and
// USDC-only on purpose — nothing should ever claim Robinhood Chain has
// real USDC, since it doesn't. This CASH_* pair is the separate,
// additive concept for the general "real spendable dollar balance"
// idea instead: ProfileScreen's Total cash/Deposit/Withdraw AND
// TokenTradeScreen's "Pay from"/"Receive as" pickers all switched to
// this, so a wallet holding USDG on Robinhood can actually spend or
// receive it — cross-chain via Relay on TokenTradeScreen, same as USDC
// anywhere else — instead of that balance being trapped on Robinhood
// with no way to use it for a trade on a different chain.
export const CASH_ASSET_BY_CHAIN: Partial<Record<ChainKey, 'USDC' | 'USDG'>> = {
  ...Object.fromEntries(USDC_SUPPORTED_CHAINS.map(c => [c, 'USDC' as const])),
  robinhood: 'USDG',
};
export const CASH_SUPPORTED_CHAINS = Object.keys(CASH_ASSET_BY_CHAIN) as ChainKey[];

// Trust Wallet's own community-maintained asset repo — the same
// verified logo source TokenTradeScreen's own AssetIcon effectively
// leans on for a real searched token's imageUrl, applied here to the
// two fixed cash assets instead. Scoped deliberately to only the chains
// independently confirmed to be listed under this exact slug in that
// repo — a chain left out here (hyperevm/ink/abstract/unichain/
// robinhood: none confirmed, and Robinhood Chain/USDG are too new to be
// listed at all) gets no logo attempt, falling through to CashBadge's
// own honest "$" mark rather than guessing a slug that 404s.
// USDC uses one canonical, verified icon regardless of which supported
// chain currently holds the user's cash. The old implementation depended
// on every chain having a matching Trust Wallet slug/address directory;
// newer supported chains therefore fell back to a plain "$" badge, which
// made the product look as if the USDC asset had disappeared.
// jsDelivr serves the same Trust Wallet asset without requiring a
// chain-specific directory on every network.
const CANONICAL_USDC_LOGO_URL =
  'https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png';

/** Real USDC logo for the unified cash UI. Robinhood's internal cash asset is USDG, but the user-facing product deliberately labels the aggregate cash balance as USDC. */
export function cashLogoUrl(chainKey: ChainKey): string | null {
  return CASH_ASSET_BY_CHAIN[chainKey] ? CANONICAL_USDC_LOGO_URL : null;
}

/** A chain's cash balance minus whatever must stay behind to pay that chain's gas, clamped to 0. */
export function spendableCash(chainKey: ChainKey, balance: number): number {
  if (chainKey !== 'arc') return balance;
  const spendable = balance - ARC_GAS_RESERVE_USDC;
  return spendable > 0 ? spendable : 0;
}

/**
 * The whole portfolio's spendable cash — totalUsd with each chain's gas
 * reserve taken out. Counts only the Relay chains (`results`): USDC on NEAR
 * is in totalUsd but can't pay a Relay route, so it is spent through the
 * NEAR trade path instead, never offered here.
 */
export function spendableTotalUsd(portfolio: CashPortfolio | null): number {
  if (!portfolio) return 0;
  return portfolio.results.reduce((sum, r) => (r.status === 'ok' ? sum + spendableCash(r.chainKey, r.balance) : sum), 0);
}

export type ChainCashResult =
  | {chainKey: ChainKey; asset: 'USDC' | 'USDG'; status: 'ok'; balance: number}
  | {chainKey: ChainKey; asset: 'USDC' | 'USDG'; status: 'error'; error: string};

export type CashPortfolio = {
  results: ChainCashResult[];
  /** USDC on NEAR (null when NEAR is off / no NEAR account) — already included in totalUsd, not in spendableTotalUsd. */
  near?: NearCashResult | null;
  totalUsd: number;
  complete: boolean;
};

async function fetchOneChainCash(chainKey: ChainKey, session: DerivedAccounts): Promise<number> {
  const asset = CASH_ASSET_BY_CHAIN[chainKey];
  if (!asset) throw new Error(`No verified cash asset for ${chainKey}.`);
  const address = TOKEN_ADDRESSES[asset]?.[chainKey];
  if (!address) throw new Error(`No verified ${asset} address for ${chainKey}.`);
  const decimals = assetDecimalsForChain(chainKey, asset) ?? ASSET_ONCHAIN_DECIMALS[asset];
  if (chainKey === 'solana') {
    return fetchWalletSplTokenBalance(address, decimals, session.solana.address);
  }
  return fetchWalletTokenBalance(chainKey, address, decimals, session.evm.address);
}

/** Same shape/discipline as fetchUsdcPortfolio above, over CASH_SUPPORTED_CHAINS instead. */
const cashPortfolioCache = makePortfolioCache<CashPortfolio>();

export async function fetchCashPortfolio(session: DerivedAccounts, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<CashPortfolio> {
  const key = sessionCacheKey(session);
  if (!forceFresh) {
    const cached = cashPortfolioCache.get(key);
    if (cached) return cached;
    const inFlight = cashPortfolioCache.getInFlight(key);
    if (inFlight) return inFlight;
  }
  return cashPortfolioCache.run(key, async () => {
    const [settled, near] = await Promise.all([Promise.allSettled(CASH_SUPPORTED_CHAINS.map(chainKey => fetchOneChainCash(chainKey, session))), nearCashFor(session)]);

    const results: ChainCashResult[] = settled.map((outcome, i) => {
      const chainKey = CASH_SUPPORTED_CHAINS[i];
      const asset = CASH_ASSET_BY_CHAIN[chainKey] as 'USDC' | 'USDG';
      if (outcome.status === 'fulfilled') {
        return {chainKey, asset, status: 'ok', balance: outcome.value};
      }
      const error = outcome.reason instanceof Error ? outcome.reason.message : "Could not fetch this chain's balance.";
      return {chainKey, asset, status: 'error', error};
    });

    const totalUsd = results.reduce((sum, r) => (r.status === 'ok' ? sum + r.balance : sum), 0);
    const complete = results.every(r => r.status === 'ok');

    return withNearCash({results, totalUsd, complete}, near);
  });
}
