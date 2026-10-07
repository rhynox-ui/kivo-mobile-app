// Token market data for the token detail screen: DexScreener for the
// pair/stats (same exact-chain, highest-liquidity rule as the engine's
// core/dexScreener.ts) and GeckoTerminal OHLCV for the price chart.
// Every failure resolves to null/[] so the UI shows "unavailable",
// never invented numbers.

import {dexScreenerChainForChain, type DexScreenerPair, type TokenSocialLink} from '../core/dexScreener';
import type {TradeChain} from '../core/chainData';
import {geckoTerminalNetworkForChainOrNull} from '../core/geckoTerminalNetworks';
import type {KivoToken} from './tokens';

export type TokenMarket = {
  token: KivoToken;
  pairAddress: string;
  dexId: string | null;
  volumeUsd24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairCreatedAt: number | null;
  socialLinks: TokenSocialLink[];
  dexScreenerUrl: string;
};

type FullPair = DexScreenerPair & {dexId?: string; url?: string};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchTokenMarket(chainKey: TradeChain, tokenAddress: string): Promise<TokenMarket | null> {
  const chainId = dexScreenerChainForChain(chainKey);
  if (!chainId) return null;
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {pairs?: FullPair[]};
    let best: FullPair | null = null;
    let bestLiquidity = -1;
    for (const pair of Array.isArray(body?.pairs) ? body.pairs : []) {
      if (pair?.chainId !== chainId || !pair.pairAddress) continue;
      if (pair.baseToken?.address?.toLowerCase() !== tokenAddress.toLowerCase()) continue;
      const liquidity = num(pair.liquidity?.usd) ?? 0;
      if (liquidity > bestLiquidity) { bestLiquidity = liquidity; best = pair; }
    }
    if (!best || !best.pairAddress) return null;
    const socialLinks: TokenSocialLink[] = [];
    for (const social of best.info?.socials ?? []) {
      const kind = social?.type === 'twitter' || social?.type === 'x' ? 'x' : social?.type === 'telegram' ? 'telegram' : null;
      if (kind && social?.url && !socialLinks.some(link => link.kind === kind)) socialLinks.push({kind, url: social.url});
    }
    const website = best.info?.websites?.find(item => typeof item?.url === 'string' && item.url);
    if (website?.url) socialLinks.push({kind: 'website', url: website.url});
    return {
      token: {
        chainKey,
        tokenAddress,
        symbol: String(best.baseToken?.symbol ?? '?'),
        name: String(best.baseToken?.name ?? best.baseToken?.symbol ?? 'Unknown token'),
        imageUrl: typeof best.info?.imageUrl === 'string' ? best.info.imageUrl : null,
        priceUsd: num(best.priceUsd),
        change24h: num(best.priceChange?.h24),
        marketCapUsd: num(best.marketCap ?? best.fdv),
        liquidityUsd: num(best.liquidity?.usd),
        volumeUsd24h: num(best.volume?.h24),
      },
      pairAddress: best.pairAddress,
      dexId: typeof best.dexId === 'string' ? best.dexId : null,
      volumeUsd24h: num(best.volume?.h24),
      buys24h: num(best.txns?.h24?.buys),
      sells24h: num(best.txns?.h24?.sells),
      pairCreatedAt: num(best.pairCreatedAt),
      socialLinks,
      dexScreenerUrl: typeof best.url === 'string' ? best.url : `https://dexscreener.com/${chainId}/${best.pairAddress}`,
    };
  } catch {
    return null;
  }
}

export type ChartRange = '1H' | '1D' | '1W' | '1M';
export type Candle = {time: number; open: number; high: number; low: number; close: number; volume: number};

const RANGE_QUERY: Record<ChartRange, {timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number}> = {
  '1H': {timeframe: 'minute', aggregate: 1, limit: 60},
  '1D': {timeframe: 'minute', aggregate: 15, limit: 96},
  '1W': {timeframe: 'hour', aggregate: 1, limit: 168},
  '1M': {timeframe: 'hour', aggregate: 4, limit: 180},
};

const candleCache = new Map<string, {data: Candle[]; fetchedAt: number}>();
const CANDLE_TTL_MS = 30_000;

export async function fetchCandles(chainKey: TradeChain, pairAddress: string, range: ChartRange): Promise<Candle[]> {
  if (chainKey === 'near') return [];
  const network = geckoTerminalNetworkForChainOrNull(chainKey);
  if (!network) return [];
  const key = `${network}:${pairAddress}:${range}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_TTL_MS) return cached.data;
  const {timeframe, aggregate, limit} = RANGE_QUERY[range];
  try {
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`);
    if (!response.ok) return [];
    const body = (await response.json()) as {data?: {attributes?: {ohlcv_list?: unknown[][]}}};
    const list = body?.data?.attributes?.ohlcv_list ?? [];
    const candles = list
      .map(row => ({time: Number(row[0]) * 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])}))
      .filter(candle => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);
    candleCache.set(key, {data: candles, fetchedAt: Date.now()});
    return candles;
  } catch {
    return [];
  }
}
