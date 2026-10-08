// Portfolio for the profile screen — ported from Mango Pro's
// wallet/portfolioHistory.ts (snapshots, ranges, change) and
// wallet/openPositions.ts (open / closed positions), adapted to Kivo:
// Mango values holdings through its own server-side indexer; Kivo reads
// them directly on-chain through the engine's RPC transports instead:
//   - native coin on every supported EVM chain (priced via CoinGecko, core/walletPrices)
//   - USDC on every chain Kivo can pay from (cash)
//   - every token this wallet traded in Kivo (priced via DexScreener)
// Tokens received from outside Kivo and never traded here are not
// discovered (no indexer), and the UI says so.

import type {KeyValueStorage} from '../../shared/storage';
import {CHAIN_LABEL, NATIVE_SYMBOL, type ChainKey} from '../core/chainData';
import {resolveDexScreenerPair} from '../core/dexScreener';
import {fetchWalletPrices} from '../core/walletPrices';
import {cashAssetSymbol, fetchCashBalances, readNativeBalance, readSolanaNativeBalance, readSolanaTokenBalance, readTokenBalance} from './balances';
import type {TradeRecord} from './history';
import {EVM_TRADE_CHAINS} from './tokens';
import {fetchWalletAssets} from './walletAssets';

export type Holding = {
  key: string;
  kind: 'native' | 'cash' | 'token';
  chainKey: ChainKey;
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
};

export type Portfolio = {
  holdings: Holding[];
  totalUsd: number;
  cashUsd: number;
  complete: boolean;
  fetchedAt: number;
};

export type ClosedPosition = {key: string; chainKey: ChainKey; address: string; symbol: string; imageUrl: string | null; lastTradeAt: number};

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
const DUST_USD = 0.005;

/** Tokens traded in Kivo, newest first, one per chain+address. */
function tradedTokens(history: TradeRecord[]) {
  const seen = new Map<string, TradeRecord['token'] & {lastTradeAt: number}>();
  for (const trade of history) {
    const key = `${trade.token.chainKey}:${trade.token.address.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, {...trade.token, lastTradeAt: trade.createdAt});
  }
  return [...seen.values()];
}

export async function fetchPortfolio(owner: string, history: TradeRecord[], addresses?: {solanaAddress?: string; nearAddress?: string}): Promise<Portfolio> {
  let complete = true;
  const prices = await fetchWalletPrices().catch(() => { complete = false; return {} as Record<string, number>; });

  // Arc's native coin IS USDC (same balance as the ERC-20 view) — counted once, as cash.
  const nativeChains = EVM_TRADE_CHAINS.filter(chain => chain !== 'arc');
  const [natives, cash, tokens, indexedAssets] = await Promise.all([
    Promise.allSettled(nativeChains.map(chain => readNativeBalance(chain, owner))),
    fetchCashBalances(owner, undefined, addresses?.solanaAddress ?? owner),
    Promise.allSettled(tradedTokens(history).map(async token => {
      const [balance, pair] = await Promise.all([
        token.chainKey === 'solana' ? readSolanaTokenBalance(token.address, owner, token.symbol) : readTokenBalance(token.chainKey, token.address, owner, token.symbol),
        resolveDexScreenerPair({chainKey: token.chainKey, tokenAddress: token.address}),
      ]);
      return {token, balance, priceUsd: pair?.priceUsd ?? null};
    })),
  ]);

  const holdings: Holding[] = [];
  natives.forEach((outcome, index) => {
    const chainKey = nativeChains[index];
    if (outcome.status !== 'fulfilled') { complete = false; return; }
    const symbol = NATIVE_SYMBOL[chainKey];
    const priceUsd = prices[symbol] ?? null;
    holdings.push({key: `${chainKey}:native`, kind: 'native', chainKey, address: NATIVE_ADDRESS, symbol, name: `${symbol} · ${CHAIN_LABEL[chainKey]}`, amount: outcome.value.amount, priceUsd, valueUsd: priceUsd == null ? null : outcome.value.amount * priceUsd, imageUrl: null});
  });
  if (addresses?.solanaAddress) {
    try {
      const sol = await readSolanaNativeBalance(addresses.solanaAddress);
      const priceUsd = prices.SOL ?? null;
      holdings.push({key: 'solana:native', kind: 'native', chainKey: 'solana', address: sol.tokenAddress, symbol: 'SOL', name: 'SOL · Solana', amount: sol.amount, priceUsd, valueUsd: priceUsd == null ? null : sol.amount * priceUsd, imageUrl: null});
    } catch {
      complete = false;
    }
  }
  let cashUsd = 0;
  for (const row of cash) {
    if (row.status !== 'ok') { complete = false; continue; }
    cashUsd += row.balance.amount;
    holdings.push({key: `${row.chainKey}:${cashAssetSymbol(row.chainKey).toLowerCase()}`, kind: 'cash', chainKey: row.chainKey, address: row.balance.tokenAddress, symbol: cashAssetSymbol(row.chainKey), name: `${cashAssetSymbol(row.chainKey)} · ${CHAIN_LABEL[row.chainKey]}`, amount: row.balance.amount, priceUsd: 1, valueUsd: row.balance.amount, imageUrl: null});
  }
  if (indexedAssets.status === 'fulfilled' && indexedAssets.value) {
    if (!indexedAssets.value.complete) complete = false;
    for (const asset of indexedAssets.value.holdings) {
      if (asset.isNative || asset.chainKey === 'near' || asset.symbol === 'USDC' || asset.symbol === 'USDG' || asset.amount <= 0) continue;
      const key = asset.chainKey + ':' + asset.address;
      if (holdings.some(h => h.key.toLowerCase() === key.toLowerCase())) continue;
      holdings.push({key,kind:'token',chainKey:asset.chainKey,address:asset.address,symbol:asset.symbol,name:asset.name,amount:asset.amount,priceUsd:asset.priceUsd,valueUsd:asset.valueUsd,imageUrl:asset.imageUrl});
    }
  }
  for (const outcome of tokens) {
    if (outcome.status !== 'fulfilled') { complete = false; continue; }
    const {token, balance, priceUsd} = outcome.value;
    holdings.push({key: `${token.chainKey}:${token.address.toLowerCase()}`, kind: 'token', chainKey: token.chainKey, address: token.address, symbol: token.symbol, name: token.name, amount: balance.amount, priceUsd, valueUsd: priceUsd == null ? null : balance.amount * priceUsd, imageUrl: token.imageUrl});
  }

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
  return {holdings, totalUsd, cashUsd, complete, fetchedAt: Date.now()};
}

/** Holdings worth showing as open positions (non-dust). */
export function openHoldings(portfolio: Portfolio): Holding[] {
  return portfolio.holdings.filter(h => h.amount > 0 && (h.valueUsd == null ? h.kind === 'token' : h.valueUsd >= DUST_USD));
}

/** Tokens bought in Kivo whose on-chain balance is now (near) zero — Mango's "Closed" tab, one row per token. */
export function closedPositions(portfolio: Portfolio, history: TradeRecord[]): ClosedPosition[] {
  const held = new Map(portfolio.holdings.filter(h => h.kind === 'token').map(h => [h.key, h]));
  return tradedTokens(history)
    .filter(t => t.chainKey !== 'solana')
    .filter(t => {
      const h = held.get(`${t.chainKey}:${t.address.toLowerCase()}`);
      return h && (h.amount === 0 || (h.valueUsd != null && h.valueUsd < DUST_USD));
    })
    .map(t => ({key: `${t.chainKey}:${t.address.toLowerCase()}`, chainKey: t.chainKey, address: t.address, symbol: t.symbol, imageUrl: t.imageUrl, lastTradeAt: t.lastTradeAt}));
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
