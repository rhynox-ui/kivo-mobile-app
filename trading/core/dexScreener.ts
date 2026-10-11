import { NEAR_ENABLED, type ChainKey, type TradeChain } from './chainData';
import {marketUrl} from './marketHosts';

const DEXSCREENER_CHAIN_IDS: Partial<Record<ChainKey, string>> = {
  ethereum: 'ethereum',
  base: 'base',
  bnb: 'bsc',
  solana: 'solana',
  arbitrum: 'arbitrum',
  avalanche: 'avalanche',
  robinhood: 'robinhood',
  abstract: 'abstract',
  hyperevm: 'hyperevm',
  ink: 'ink',
  plasma: 'plasma',
  unichain: 'unichain',
  xlayer: 'xlayer',
  arc: 'arc',
};

export function dexScreenerChainForChain(chainKey: TradeChain): string | null {
  if (chainKey === 'near') return 'near';
  return DEXSCREENER_CHAIN_IDS[chainKey] ?? null;
}

let reverseChainIds: Map<string, ChainKey> | null = null;

export function chainKeyForDexScreenerChainId(chainId: string): ChainKey | null {
  if (!reverseChainIds) {
    reverseChainIds = new Map(
      Object.entries(DEXSCREENER_CHAIN_IDS).map(([key, id]) => [id as string, key as ChainKey]),
    );
  }
  return reverseChainIds.get(chainId) ?? null;
}

export function tradeChainForDexScreenerChainId(chainId: string): TradeChain | null {
  if (chainId === 'near') return NEAR_ENABLED ? 'near' : null;
  return chainKeyForDexScreenerChainId(chainId);
}

export type DexScreenerPair = {
  chainId?: string;
  pairAddress?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label?: string; url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
};

export type TokenSocialLink = { kind: 'x' | 'telegram' | 'website'; url: string };
export type ResolvedPair = {
  chainId: string;
  pairAddress: string;
  socialLinks: TokenSocialLink[];
  priceUsd: number | null;
  marketCapUsd: number | null;
  imageUrl?: string | null;
};

function socialKindFor(type: string | undefined): 'x' | 'telegram' | null {
  if (type === 'twitter' || type === 'x') return 'x';
  if (type === 'telegram') return 'telegram';
  return null;
}

function extractSocialLinks(pair: DexScreenerPair | undefined): TokenSocialLink[] {
  const links: TokenSocialLink[] = [];
  const seen = new Set<string>();
  const add = (kind: TokenSocialLink['kind'], url: string | undefined) => {
    if (!url || seen.has(kind)) return;
    seen.add(kind);
    links.push({ kind, url });
  };
  for (const social of pair?.info?.socials ?? []) {
    const kind = socialKindFor(social?.type);
    if (kind) add(kind, social?.url);
  }
  const website = pair?.info?.websites?.find(w => typeof w?.url === 'string' && w.url);
  add('website', website?.url);
  return links;
}

const PAIR_CACHE_TTL_MS = 30_000;
const pairCache = new Map<string, { data: ResolvedPair | null; fetchedAt: number }>();
const pairInFlight = new Map<string, Promise<ResolvedPair | null>>();

export async function resolveDexScreenerPair({
  chainKey,
  tokenAddress,
}: {
  chainKey: TradeChain;
  tokenAddress: string | null;
}): Promise<ResolvedPair | null> {
  const chainId = dexScreenerChainForChain(chainKey);
  if (!chainId || !tokenAddress) return null;

  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = pairCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PAIR_CACHE_TTL_MS) return cached.data;
  const inFlight = pairInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = resolveDexScreenerPairUncached(chainId, tokenAddress).then(data => {
    pairCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  });
  pairInFlight.set(key, promise);
  promise.finally(() => pairInFlight.delete(key));
  return promise;
}

async function resolveDexScreenerPairUncached(chainId: string, tokenAddress: string): Promise<ResolvedPair | null> {
  try {
    const response = await fetch(
      marketUrl('dexscreener', `/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`),
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { pairs?: DexScreenerPair[] };
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    // Prefer pairs where this token is the base token: DexScreener's price,
    // market cap and image always describe the base token, never the quote.
    const wanted = tokenAddress.toLowerCase();
    let best: DexScreenerPair | null = null;
    let bestRank = -1;
    for (const pair of pairs) {
      if (pair?.chainId !== chainId) continue;
      if (typeof pair?.pairAddress !== 'string' || !pair.pairAddress) continue;
      const liquidity = Number(pair?.liquidity?.usd);
      const isBase = String(pair.baseToken?.address ?? '').toLowerCase() === wanted;
      const ranked = (Number.isFinite(liquidity) ? liquidity : 0) + (isBase ? 1e15 : 0);
      if (ranked > bestRank) {
        bestRank = ranked;
        best = pair;
      }
    }
    if (!best || !best.pairAddress) return null;
    // Only quoted on the other side of a pair: keep the pair for the chart, but its numbers are not this token's.
    const isBase = String(best.baseToken?.address ?? '').toLowerCase() === wanted;
    const priceUsd = isBase ? Number(best.priceUsd) : NaN;
    const marketCapUsd = isBase ? Number(best.marketCap ?? best.fdv) : NaN;
    return {
      chainId,
      pairAddress: best.pairAddress,
      socialLinks: extractSocialLinks(best),
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
      imageUrl: isBase && typeof best.info?.imageUrl === 'string' && best.info.imageUrl ? best.info.imageUrl : null,
    };
  } catch {
    return null;
  }
}

export function dexScreenerEmbedUrl({
  chainId,
  pairAddress,
  theme,
}: {
  chainId: string;
  pairAddress: string;
  theme: 'light' | 'dark';
}): string {
  const params = [
    'embed=1',
    `theme=${theme}`,
    `chartTheme=${theme}`,
    'trades=0',
    'info=0',
    'tabs=0',
    'chartLeftToolbar=0',
    'loadChartSettings=0',
    'chartDefaultOnMobile=1',
    'chartType=usd',
    'interval=60',
  ].join('&');
  return `https://dexscreener.com/${chainId}/${pairAddress}?${params}`;
}
