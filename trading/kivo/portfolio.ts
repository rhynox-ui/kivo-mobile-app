// Portfolio for the profile screen — ported from Mango Pro's
// wallet/portfolioHistory.ts (snapshots, ranges, change) and
// wallet/openPositions.ts (open / closed positions), adapted to Kivo:
// Mango values holdings through its own server-side indexer; Kivo reads
// them directly on-chain through the engine's RPC transports instead:
//   - native coin on every supported EVM chain (priced via CoinGecko, core/walletPrices)
//   - USDC on every chain Kivo can pay from (cash)
//   - every token this wallet traded in Kivo (priced via DexScreener)
//   - other tokens the wallet holds, from Mango's wallet-asset indexer
// Every source fails on its own: a source that did not answer is listed in
// `missing` (never counted as $0), and the chart only records a point when
// each missing source has a recent confirmed reading (chartTotal).

import type {KeyValueStorage} from '../../shared/storage';
import {CHAIN_LABEL, NATIVE_SYMBOL, NEAR_USDC, NEAR_USDC_DECIMALS, tradeChainLabel, type ChainKey, type TradeChain} from '../core/chainData';
import {resolveDexScreenerPair} from '../core/dexScreener';
import {fetchWalletPrices} from '../core/walletPrices';
import {cashAssetSymbol, fetchCashBalances, readNativeBalance, readSolanaNativeBalance, readSolanaTokenBalance, readTokenBalance} from './balances';
import type {TradeRecord} from './history';
import {EVM_TRADE_CHAINS} from './tokens';
import {fetchWalletAssets} from './walletAssets';
import {fetchNearTokenBalance} from '../core/nearTrade';

export type Holding = {
  key: string;
  kind: 'native' | 'cash' | 'token';
  chainKey: TradeChain;
  address: string;
  symbol: string;
  name: string;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  imageUrl: string | null;
  entryPriceUsd?: number | null;
  pnlUsd?: number | null;
  pnlPct?: number | null;
  /** Set when only the wallet-asset indexer reported this holding. */
  source?: 'indexer';
};

export type Portfolio = {
  holdings: Holding[];
  totalUsd: number;
  cashUsd: number;
  complete: boolean;
  /**
   * Sources that did not respond (or a held coin with no price): holding keys
   * (`chain:native`, `chain:usdc`, `chain:0x…`), `indexer` for the whole
   * wallet-asset index, or `<network>:indexer` for one network it could not read.
   */
  missing?: string[];
  fetchedAt: number;
};

export type ClosedPosition = {key: string; chainKey: TradeChain; address: string; symbol: string; imageUrl: string | null; lastTradeAt: number};

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
const DUST_USD = 0.005;

// Portfolio is assembled from multiple RPC/indexer/price sources. Cache the
// complete result briefly so switching Profile tabs or re-rendering the
// screen does not fan out the same chain reads again. Keep the cache account
// and trade-history aware, and share an in-flight request between callers.
const PORTFOLIO_CACHE_TTL_MS = 30_000;
let portfolioCache: {key: string; data: Portfolio; fetchedAt: number} | null = null;
let portfolioInFlight: {key: string; promise: Promise<Portfolio>} | null = null;

function portfolioCacheKey(owner: string, history: TradeRecord[], addresses?: {solanaAddress?: string; nearAddress?: string}): string {
  const last = history.length ? history[history.length - 1] : null;
  return [
    owner.toLowerCase(),
    addresses?.solanaAddress ?? '',
    addresses?.nearAddress ?? '',
    history.length,
    last?.createdAt ?? '',
    last?.status ?? '',
  ].join(':');
}


/** One key per token: EVM addresses are case-insensitive, Solana mints are not. */
export function holdingKey(chainKey: string, address: string): string {
  return chainKey === 'solana' ? `solana:${address}` : `${chainKey}:${address.toLowerCase()}`;
}

/** Tokens traded in Kivo, newest first, one per chain+address. */
function tradedTokens(history: TradeRecord[]) {
  const seen = new Map<string, TradeRecord['token'] & {lastTradeAt: number}>();
  for (const trade of history) {
    const key = holdingKey(trade.token.chainKey, trade.token.address);
    if (!seen.has(key)) seen.set(key, {...trade.token, lastTradeAt: trade.createdAt});
  }
  return [...seen.values()];
}

export async function fetchPortfolio(owner: string, history: TradeRecord[], addresses?: {solanaAddress?: string; nearAddress?: string}, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<Portfolio> {
  const key = portfolioCacheKey(owner, history, addresses);
  if (!forceFresh) {
    if (portfolioCache && portfolioCache.key === key && Date.now() - portfolioCache.fetchedAt < PORTFOLIO_CACHE_TTL_MS) return portfolioCache.data;
    if (portfolioInFlight?.key === key) return portfolioInFlight.promise;
  }
  const promise = fetchPortfolioUncached(owner, history, addresses, {forceFresh});
  portfolioInFlight = {key, promise};
  promise.then(
    data => {
      portfolioCache = {key, data, fetchedAt: Date.now()};
      if (portfolioInFlight?.promise === promise) portfolioInFlight = null;
    },
    () => {
      if (portfolioInFlight?.promise === promise) portfolioInFlight = null;
    },
  );
  return promise;
}

async function fetchPortfolioUncached(owner: string, history: TradeRecord[], addresses?: {solanaAddress?: string; nearAddress?: string}, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<Portfolio> {
  let complete = true;
  const missing: string[] = [];
  const miss = (source: string) => { complete = false; if (!missing.includes(source)) missing.push(source); };
  const prices = await fetchWalletPrices().catch(() => { complete = false; return {} as Record<string, number>; });
  const traded = tradedTokens(history).filter(token => token.chainKey !== 'near');

  // Arc's native coin IS USDC (same balance as the ERC-20 view) — counted once, as cash.
  const nativeChains = EVM_TRADE_CHAINS.filter(chain => chain !== 'arc');
  const [natives, cash, nearCash, tokens, indexedAssets] = await Promise.all([
    Promise.allSettled(nativeChains.map(chain => readNativeBalance(chain, owner, {forceFresh}))),
    fetchCashBalances(owner, undefined, addresses?.solanaAddress, {forceFresh}),
    // null = NEAR did not answer (never a fake 0).
    addresses?.nearAddress ? fetchNearTokenBalance(NEAR_USDC, addresses.nearAddress).catch(() => null) : Promise.resolve(undefined),
    Promise.allSettled(traded.map(async token => {
      const [balance, pair] = await Promise.all([
        token.chainKey === 'solana' ? readSolanaTokenBalance(token.address, addresses?.solanaAddress ?? owner, token.symbol) : readTokenBalance(token.chainKey as ChainKey, token.address, owner, token.symbol),
        resolveDexScreenerPair({chainKey: token.chainKey, tokenAddress: token.address}),
      ]);
      return {token, balance, priceUsd: pair?.priceUsd ?? null};
    })),
    // The indexer is one source among several: when it fails or hangs, the
    // rest of the portfolio still loads and the index is reported missing.
    fetchWalletAssets(owner, addresses?.solanaAddress ?? owner, addresses?.nearAddress ?? null, {forceFresh}).catch(() => null),
  ]);

  const holdings: Holding[] = [];
  const byKey = new Map<string, Holding>();
  /** Adds a token row once per chain+address; a duplicate only replaces a row that had no price. */
  const addToken = (row: Holding) => {
    const existing = byKey.get(row.key);
    if (!existing) { byKey.set(row.key, row); holdings.push(row); return; }
    if (existing.priceUsd == null && row.priceUsd != null) {
      Object.assign(existing, row, {source: undefined, imageUrl: row.imageUrl ?? existing.imageUrl});
    } else if (existing.source === 'indexer' && row.source !== 'indexer') {
      // Kivo also read it on-chain: it no longer depends on the indexer alone.
      existing.source = undefined;
    }
  };
  natives.forEach((outcome, index) => {
    const chainKey = nativeChains[index];
    const key = `${chainKey}:native`;
    if (outcome.status !== 'fulfilled') { miss(key); return; }
    const symbol = NATIVE_SYMBOL[chainKey];
    const priceUsd = prices[symbol] ?? null;
    const amount = outcome.value.amount;
    // An empty balance is worth $0 at any price; only a held coin needs its price.
    if (priceUsd == null && amount > 0) miss(key);
    holdings.push({key, kind: 'native', chainKey, address: NATIVE_ADDRESS, symbol, name: `${symbol} · ${CHAIN_LABEL[chainKey]}`, amount, priceUsd, valueUsd: priceUsd == null ? (amount > 0 ? null : 0) : amount * priceUsd, imageUrl: null});
  });
  if (addresses?.solanaAddress) {
    try {
      const sol = await readSolanaNativeBalance(addresses.solanaAddress, {forceFresh});
      const priceUsd = prices.SOL ?? null;
      if (priceUsd == null && sol.amount > 0) miss('solana:native');
      holdings.push({key: 'solana:native', kind: 'native', chainKey: 'solana', address: sol.tokenAddress, symbol: 'SOL', name: 'SOL · Solana', amount: sol.amount, priceUsd, valueUsd: priceUsd == null ? (sol.amount > 0 ? null : 0) : sol.amount * priceUsd, imageUrl: null});
    } catch {
      miss('solana:native');
    }
  }
  let cashUsd = 0;
  for (const row of cash) {
    const key = `${row.chainKey}:${cashAssetSymbol(row.chainKey).toLowerCase()}`;
    if (row.status !== 'ok') { miss(key); continue; }
    cashUsd += row.balance.amount;
    holdings.push({key, kind: 'cash', chainKey: row.chainKey, address: row.balance.tokenAddress, symbol: cashAssetSymbol(row.chainKey), name: `${cashAssetSymbol(row.chainKey)} · ${CHAIN_LABEL[row.chainKey]}`, amount: row.balance.amount, priceUsd: 1, valueUsd: row.balance.amount, imageUrl: null});
  }
  if (addresses?.nearAddress) {
    if (nearCash == null) miss('near:usdc');
    else {
      const amount = Number(nearCash) / 10 ** NEAR_USDC_DECIMALS;
      cashUsd += amount;
      holdings.push({key: 'near:usdc', kind: 'cash', chainKey: 'near', address: NEAR_USDC, symbol: 'USDC', name: 'USDC · NEAR', amount, priceUsd: 1, valueUsd: amount, imageUrl: null});
    }
  }
  if (!indexedAssets) miss('indexer');
  else {
    if (!indexedAssets.complete) {
      const networks = indexedAssets.partialErrors.map(error => (typeof error?.network === 'string' && error.network.trim() ? error.network.trim().toLowerCase() : null));
      if (!networks.length || networks.some(network => network == null)) miss('indexer:partial');
      for (const network of networks) if (network) miss(`${network}:indexer`);
    }
    for (const asset of indexedAssets.holdings) {
      if (asset.isNative || asset.chainKey === 'near' || asset.symbol === 'USDC' || asset.symbol === 'USDG' || asset.amount <= 0) continue;
      addToken({key: holdingKey(asset.chainKey, asset.address), kind: 'token', chainKey: asset.chainKey, address: asset.address, symbol: asset.symbol, name: asset.name, amount: asset.amount, priceUsd: asset.priceUsd, valueUsd: asset.priceUsd == null ? asset.valueUsd : asset.amount * asset.priceUsd, imageUrl: asset.imageUrl, source: 'indexer'});
    }
  }
  tokens.forEach((outcome, index) => {
    const key = holdingKey(traded[index].chainKey, traded[index].address);
    if (outcome.status !== 'fulfilled') {
      // The indexer already reported this token: its row stands; otherwise it is missing.
      if (!byKey.has(key)) miss(key);
      return;
    }
    const {token, balance, priceUsd} = outcome.value;
    addToken({key, kind: 'token', chainKey: token.chainKey, address: token.address, symbol: token.symbol, name: token.name, amount: balance.amount, priceUsd, valueUsd: priceUsd == null ? null : balance.amount * priceUsd, imageUrl: token.imageUrl});
  });

  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  for (const holding of holdings) {
    if (holding.kind !== 'token') continue;
    let boughtAmount = 0;
    let boughtCost = 0;
    for (const trade of history) {
      if (trade.status !== 'success' || trade.token.chainKey !== holding.chainKey || trade.token.address.toLowerCase() !== holding.address.toLowerCase()) continue;
      const received = Number(trade.receive.amount ?? 0);
      const paid = Number(trade.pay.amount ?? 0);
      if (trade.side === 'buy' && received > 0 && paid > 0) { boughtAmount += received; boughtCost += paid; }
    }
    if (boughtAmount > 0 && boughtCost > 0) {
      const entry = boughtCost / boughtAmount;
      holding.entryPriceUsd = entry;
      if (holding.valueUsd != null) {
        const cost = holding.amount * entry;
        holding.pnlUsd = holding.valueUsd - cost;
        holding.pnlPct = cost > 0 ? (holding.pnlUsd / cost) * 100 : null;
      }
    }
  }
  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  return {holdings, totalUsd, cashUsd, complete, missing, fetchedAt: Date.now()};
}

/** Holdings worth showing as open positions (non-dust). */
export function openHoldings(portfolio: Portfolio): Holding[] {
  return portfolio.holdings.filter(h => h.amount > 0 && (h.valueUsd == null ? h.kind === 'token' : h.valueUsd >= DUST_USD));
}

/** Tokens bought in Kivo whose on-chain balance is now (near) zero — Mango's "Closed" tab, one row per token. */
export function closedPositions(portfolio: Portfolio, history: TradeRecord[]): ClosedPosition[] {
  const held = new Map(portfolio.holdings.filter(h => h.kind === 'token').map(h => [h.key, h]));
  return tradedTokens(history)
    .filter(t => t.chainKey !== 'solana' && t.chainKey !== 'near')
    .filter(t => {
      const h = held.get(holdingKey(t.chainKey, t.address));
      return h && (h.amount === 0 || (h.valueUsd != null && h.valueUsd < DUST_USD));
    })
    .map(t => ({key: holdingKey(t.chainKey, t.address), chainKey: t.chainKey, address: t.address, symbol: t.symbol, imageUrl: t.imageUrl, lastTradeAt: t.lastTradeAt}));
}

// ---------------------------------------------------------------------
// History — same rules as Mango Pro's portfolioHistory.ts.

export type PortfolioSnapshot = {timestamp: number; totalUsd: number};
export type PortfolioRange = '24h' | '7d' | '30d' | 'All';
export type PortfolioChange = {absolute: number; percent: number; isPositive: boolean};

const KEY_PREFIX = 'kivo:portfolio-history:v1:';
const MAX_SNAPSHOTS = 500;
/** One point per 5 minutes at most, so 24h stays meaningfully different from All. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const RANGE_WINDOW_MS: Record<Exclude<PortfolioRange, 'All'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export async function getPortfolioHistory(storage: KeyValueStorage, address: string): Promise<PortfolioSnapshot[]> {
  try {
    const raw = await storage.getItem(KEY_PREFIX + address.toLowerCase());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(p => Number.isFinite(p?.timestamp) && Number.isFinite(p?.totalUsd)) : [];
  } catch {
    return [];
  }
}

/** Appends a snapshot (unless one was recorded in the last 5 minutes) and returns the full history. Only call with a complete portfolio. */
export async function recordPortfolioSnapshot(storage: KeyValueStorage, address: string, totalUsd: number): Promise<PortfolioSnapshot[]> {
  const history = await getPortfolioHistory(storage, address);
  const last = history[history.length - 1];
  const now = Date.now();
  if (last && now - last.timestamp < MIN_INTERVAL_MS) {
    // Keep the newest point current without adding a new one.
    const updated = [...history.slice(0, -1), {timestamp: last.timestamp, totalUsd}];
    void Promise.resolve(storage.setItem(KEY_PREFIX + address.toLowerCase(), JSON.stringify(updated))).catch(() => {});
    return updated;
  }
  const next = [...history, {timestamp: now, totalUsd}].slice(-MAX_SNAPSHOTS);
  void Promise.resolve(storage.setItem(KEY_PREFIX + address.toLowerCase(), JSON.stringify(next))).catch(() => {});
  return next;
}

// ---------------------------------------------------------------------
// Chart totals when a network is briefly down (ported from web). Public RPCs
// on ten-plus chains rarely all answer at once, and a strict "every network
// answered" rule meant the chart never got a point. A source that did not
// answer may reuse its own last confirmed reading, but only if that reading
// is recent; otherwise no chart point is recorded at all. Nothing is invented.

const LAST_KNOWN_PREFIX = 'kivo:portfolio-last-known:v1:';
/** How old a reused reading may be. */
export const LAST_KNOWN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type LastKnown = Record<string, {usd: number; at: number}>;

export type ChartTotal = {
  /** Total for the chart, or null when a missing source has no recent reading. */
  totalUsd: number | null;
  /** Sources whose last confirmed reading was reused. */
  reused: string[];
  /** Sources with no recent reading (why there is no chart point). */
  unknown: string[];
};

const isIndexerSource = (source: string) => source === 'indexer' || source.startsWith('indexer:') || source.endsWith(':indexer');

export async function chartTotal(storage: KeyValueStorage, address: string, portfolio: Portfolio, now = Date.now()): Promise<ChartTotal> {
  const key = LAST_KNOWN_PREFIX + address.toLowerCase();
  let known: LastKnown = {};
  try { const parsed = JSON.parse((await storage.getItem(key)) ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) known = parsed; } catch {}
  const missing = new Set(portfolio.missing ?? []);
  const indexerDown = missing.has('indexer');
  const indexerAnswered = ![...missing].some(isIndexerSource);
  // Remember every reading that did answer, priced. Holdings only the indexer
  // reported are remembered together, as the indexer's reading.
  let indexerUsd = 0;
  for (const item of portfolio.holdings) {
    if (item.source === 'indexer') { indexerUsd += item.valueUsd ?? 0; continue; }
    if (missing.has(item.key) || item.valueUsd == null) continue;
    known[item.key] = {usd: item.valueUsd, at: now};
  }
  if (indexerAnswered) known.indexer = {usd: indexerUsd, at: now};
  let total = portfolio.holdings.reduce((sum, item) => sum + (missing.has(item.key) || (indexerDown && item.source === 'indexer') ? 0 : item.valueUsd ?? 0), 0);
  const reused: string[] = [];
  const unknown: string[] = [];
  for (const source of missing) {
    const last = known[source];
    // A partly answered index has no per-network reading to reuse.
    if (source !== 'indexer' && isIndexerSource(source)) { unknown.push(source); continue; }
    if (last && Number.isFinite(last.usd) && now - last.at <= LAST_KNOWN_MAX_AGE_MS) { total += last.usd; reused.push(source); }
    else unknown.push(source);
  }
  void Promise.resolve(storage.setItem(key, JSON.stringify(known))).catch(() => {});
  return {totalUsd: unknown.length ? null : total, reused, unknown};
}

/** "Base, BNB Chain and the token index" from missing source keys, for UI notes. */
export function missingSourceNames(sources: string[]): string {
  const names = [...new Set(sources.map(source => {
    if (source === 'indexer' || source.startsWith('indexer:')) return 'the token index';
    const chain = source.split(':')[0];
    if (chain === 'near') return tradeChainLabel('near');
    return CHAIN_LABEL[chain as ChainKey] ?? chain;
  }))];
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function filterHistoryByRange(history: PortfolioSnapshot[], range: PortfolioRange): PortfolioSnapshot[] {
  if (range === 'All') return history;
  const cutoff = Date.now() - RANGE_WINDOW_MS[range];
  return history.filter(s => s.timestamp >= cutoff);
}

/** Change from first to last point in a range-filtered list; null without at least two real points. */
export function computePortfolioChange(points: PortfolioSnapshot[]): PortfolioChange | null {
  if (points.length < 2) return null;
  const first = points[0].totalUsd;
  const last = points[points.length - 1].totalUsd;
  const absolute = last - first;
  const percent = first !== 0 ? (absolute / first) * 100 : 0;
  return {absolute, percent, isPositive: absolute >= 0};
}
