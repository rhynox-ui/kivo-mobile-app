import { tradeChainForDexScreenerChainId, type DexScreenerPair } from './dexScreener';
import type { TradeChain } from './chainData';

export type TokenSearchResult = {
  chainKey: TradeChain;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number;
};

export function fmtCompactUsd(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const SEARCH_CACHE_TTL_MS = 15_000;
const searchCache = new Map<string, { data: TokenSearchResult[]; fetchedAt: number }>();
const searchInFlight = new Map<string, Promise<TokenSearchResult[]>>();

export async function searchTokens(query: string): Promise<TokenSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const key = trimmed.toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) return cached.data;

  const existing = searchInFlight.get(key);
  if (existing) return existing;

  const request = searchDexScreener(trimmed).then(data => {
    searchCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  });
  searchInFlight.set(key, request);
  request.finally(() => searchInFlight.delete(key));
  return request;
}

async function searchDexScreener(query: string): Promise<TokenSearchResult[]> {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
    );
    if (!response.ok) return [];

    const body = (await response.json()) as { pairs?: DexScreenerPair[] };
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    const bestByKey = new Map<string, TokenSearchResult>();

    for (const pair of pairs) {
      const chainKey = pair?.chainId ? tradeChainForDexScreenerChainId(pair.chainId) : null;
      const baseAddress = pair?.baseToken?.address;
      const quoteAddress = pair?.quoteToken?.address;
      const matchesBase = typeof baseAddress === 'string' && baseAddress.toLowerCase() === query.trim().toLowerCase();
      const matchesQuote = typeof quoteAddress === 'string' && quoteAddress.toLowerCase() === query.trim().toLowerCase();
      const tokenAddress = matchesBase ? baseAddress : matchesQuote ? quoteAddress : baseAddress;
      if (!chainKey || typeof tokenAddress !== 'string' || !tokenAddress) continue;

      const liquidityUsd = Number(pair?.liquidity?.usd);
      const rankedLiquidity = Number.isFinite(liquidityUsd) ? liquidityUsd : 0;
      const dedupeKey = `${chainKey}:${tokenAddress.toLowerCase()}`;
      const existing = bestByKey.get(dedupeKey);

      const imageUrl = typeof pair?.info?.imageUrl === 'string' ? pair.info.imageUrl : null;
      if (existing && existing.liquidityUsd >= rankedLiquidity) {
        if (!existing.imageUrl && imageUrl) {
          bestByKey.set(dedupeKey, { ...existing, imageUrl });
        }
        continue;
      }

      const priceUsd = Number(pair?.priceUsd);
      const change24h = Number(pair?.priceChange?.h24);
      const marketCapUsd = Number(pair?.marketCap ?? pair?.fdv);

      bestByKey.set(dedupeKey, {
        chainKey,
        tokenAddress,
        symbol: String(matchesQuote ? pair?.quoteToken?.symbol ?? '?' : pair?.baseToken?.symbol ?? '?'),
        name: String(matchesQuote ? pair?.quoteToken?.name ?? pair?.quoteToken?.symbol ?? 'Unknown token' : pair?.baseToken?.name ?? pair?.baseToken?.symbol ?? 'Unknown token'),
        imageUrl,
        priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
        change24h: Number.isFinite(change24h) ? change24h : null,
        marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
        liquidityUsd: rankedLiquidity,
      });
    }

    return Array.from(bestByKey.values()).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  } catch {
    return [];
  }
}
