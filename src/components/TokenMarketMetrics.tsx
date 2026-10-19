import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { marketFetch } from '@kivo/trading/core/marketHosts';
import { kivoTheme } from '../theme/kivoTheme';

/** imageUrl: the token's logo from the same market data, for cards saved without one. */
type Snapshot = { marketCapUsd: number | null; change24h: number | null; imageUrl?: string | null };
const httpsOrNull = (value: unknown) => typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
const cache = new Map<string, Promise<Snapshot>>();
const chainIds: Record<string, string> = { solana:'solana', ethereum:'ethereum', base:'base', bnb:'bsc', robinhood:'robinhood', arbitrum:'arbitrum', avalanche:'avalanche', abstract:'abstract', hyperevm:'hyperevm', ink:'ink', plasma:'plasma', unichain:'unichain', xlayer:'xlayer', arc:'arc' };
// Not on DexScreener yet (new launches, pump.fun bonding curve): GeckoTerminal, then Jupiter for Solana.
const PROXY = 'https://kivo-web.pages.dev/api/market';
const GECKO: Record<string, string> = { ethereum: 'eth', base: 'base', bnb: 'bsc', robinhood: 'robinhood', solana: 'solana', arbitrum: 'arbitrum', avalanche: 'avax', abstract: 'abstract', hyperevm: 'hyperevm', ink: 'ink', plasma: 'plasma', unichain: 'unichain', xlayer: 'x-layer', arc: 'arc' };
const positive = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const finite = (value: unknown) => { const n = Number(value); return value != null && Number.isFinite(n) ? n : null; };

const TIMEOUT_MS = 8_000;
const EMPTY: Snapshot = { marketCapUsd: null, change24h: null };

/** Never let one slow market host hold a card: every request gives up after 8 s. */
function withTimeout<T>(promise: Promise<T>, fallback: T, ms = TIMEOUT_MS): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

function timedFetch(url: string): Promise<Response> {
  const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  return fetch(url, { signal });
}

/** GeckoTerminal token data. Returns the logo even when there is no market cap. */
async function fromGeckoTerminal(chain: string, address: string): Promise<Snapshot | null> {
  const network = GECKO[chain.toLowerCase()];
  if (!network) return null;
  try {
    const response = await timedFetch(`${PROXY}/geckoterminal/api/v2/networks/${network}/tokens/${encodeURIComponent(address)}?include=top_pools`);
    if (!response.ok) return null;
    const body = await response.json();
    const cap = positive(body?.data?.attributes?.market_cap_usd) ?? positive(body?.data?.attributes?.fdv_usd);
    const pool = Array.isArray(body?.included) ? body.included.find((item: { type?: string }) => item.type === 'pool') : null;
    const image = body?.data?.attributes?.image_url;
    const imageUrl = typeof image === 'string' && !image.includes('missing') ? httpsOrNull(image) : null;
    if (cap == null && !imageUrl) return null;
    return { marketCapUsd: cap, change24h: cap == null ? null : finite(pool?.attributes?.price_change_percentage?.h24), imageUrl };
  } catch { return null; }
}

async function fromJupiter(address: string): Promise<Snapshot | null> {
  try {
    const response = await timedFetch(`${PROXY}/jupiter/tokens/v2/search?query=${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const rows = await response.json();
    const token = Array.isArray(rows) ? rows.find((row: { id?: string }) => row.id === address) : null;
    if (!token) return null;
    const cap = positive(token?.mcap) ?? positive(token?.fdv);
    const imageUrl = httpsOrNull(token?.icon);
    if (cap == null && !imageUrl) return null;
    return { marketCapUsd: cap, change24h: cap == null ? null : finite(token?.stats24h?.priceChange), imageUrl };
  } catch { return null; }
}

// One request per token per host, shared by the market data and the logo.
const geckoCache = new Map<string, Promise<Snapshot | null>>();
const jupiterCache = new Map<string, Promise<Snapshot | null>>();
const dexCache = new Map<string, Promise<{ snapshot: Snapshot; found: boolean }>>();
const logoCache = new Map<string, Promise<string | null>>();
const tokenKey = (chain: string, address: string) => chain.toLowerCase() + ':' + address.toLowerCase();
function gecko(chain: string, address: string) {
  const key = tokenKey(chain, address);
  let hit = geckoCache.get(key);
  if (!hit) { hit = withTimeout(fromGeckoTerminal(chain, address), null); geckoCache.set(key, hit); }
  return hit;
}
function jupiter(chain: string, address: string) {
  if (chain.toLowerCase() !== 'solana') return Promise.resolve(null);
  const key = tokenKey(chain, address);
  let hit = jupiterCache.get(key);
  if (!hit) { hit = withTimeout(fromJupiter(address), null); jupiterCache.set(key, hit); }
  return hit;
}

function fromDexScreener(chain: string, address: string): Promise<{ snapshot: Snapshot; found: boolean }> {
  const key = tokenKey(chain, address);
  const cached = dexCache.get(key); if (cached) return cached;
  const request = withTimeout((async () => {
    const chainId = chainIds[chain.toLowerCase()];
    if (!chainId || !address) return { snapshot: EMPTY, found: false };
    const response = await marketFetch('dexscreener', '/latest/dex/tokens/' + encodeURIComponent(address));
    if (!response.ok) return { snapshot: EMPTY, found: false };
    const payload = await response.json() as { pairs?: Array<{ chainId?: string; liquidity?: { usd?: number }; baseToken?: { address?: string }; marketCap?: number; priceChange?: { h24?: number }; info?: { imageUrl?: string } }> };
    const target = chain.toLowerCase() === 'solana' ? address : address.toLowerCase();
    const pairs = (Array.isArray(payload.pairs) ? payload.pairs : []).filter(pair => pair.chainId === chainId && (chain.toLowerCase() === 'solana' ? pair.baseToken?.address === target : pair.baseToken?.address?.toLowerCase() === target));
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const pair = pairs[0];
    if (!pair) return { snapshot: EMPTY, found: false };
    return { found: true, snapshot: { marketCapUsd: Number.isFinite(pair.marketCap) && Number(pair.marketCap) > 0 ? Number(pair.marketCap) : null, change24h: Number.isFinite(pair.priceChange?.h24) ? Number(pair.priceChange?.h24) : null, imageUrl: httpsOrNull(pair.info?.imageUrl) } };
  })(), { snapshot: EMPTY, found: false });
  dexCache.set(key, request);
  return request;
}

/**
 * Live market cap and 24h change, shared (one request per token) by every
 * card. Never waits for a logo: DexScreener first, then GeckoTerminal, then
 * Jupiter (Solana) for tokens not listed there yet (new launches, pump.fun).
 */
export function loadSnapshot(chain: string, address: string): Promise<Snapshot> {
  const key = tokenKey(chain, address);
  const cached = cache.get(key); if (cached) return cached;
  const request = (async (): Promise<Snapshot> => {
    if (!chainIds[chain.toLowerCase()] || !address) return EMPTY;
    const dex = await fromDexScreener(chain, address);
    if (dex.found) return dex.snapshot;
    const gt = await gecko(chain, address);
    if (gt?.marketCapUsd != null) return gt;
    const jup = await jupiter(chain, address);
    if (jup?.marketCapUsd != null) return jup;
    return { ...EMPTY, imageUrl: gt?.imageUrl ?? jup?.imageUrl ?? null };
  })().catch(() => EMPTY);
  cache.set(key, request);
  return request;
}

/** The token's logo from live market data (DexScreener, GeckoTerminal, Jupiter), loaded separately from the numbers. */
export function loadTokenLogo(chain: string, address: string): Promise<string | null> {
  const key = tokenKey(chain, address);
  const cached = logoCache.get(key); if (cached) return cached;
  const request = (async () => {
    if (!address) return null;
    const dex = await fromDexScreener(chain, address);
    if (dex.snapshot.imageUrl) return dex.snapshot.imageUrl;
    const gt = await gecko(chain, address);
    if (gt?.imageUrl) return gt.imageUrl;
    return (await jupiter(chain, address))?.imageUrl ?? null;
  })().catch(() => null);
  logoCache.set(key, request);
  return request;
}

function formatCap(value: number | null): string {
  if (value == null) return 'MC —';
  const compact = value >= 1e9 ? (value / 1e9).toFixed(1) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : Math.round(value).toLocaleString();
  return 'MC $' + compact;
}
export function TokenMarketMetrics({ chain, address, stacked = false }: { chain: string; address: string; /** MC over 24h change, right-aligned (token card header). */ stacked?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ marketCapUsd: null, change24h: null });
  useEffect(() => { let active = true; void loadSnapshot(chain, address).then(value => { if (active) setSnapshot(value); }); return () => { active = false; }; }, [chain, address]);
  const change = snapshot.change24h;
  const changeText = change == null ? '—' : (change > 0 ? '+' : '') + change.toFixed(2) + '%';
  if (stacked) return <View style={styles.stack}><Text numberOfLines={1} style={styles.capStrong}>{formatCap(snapshot.marketCapUsd).replace(/^MC (.*)$/, '$1 MC')}</Text><Text numberOfLines={1} style={[styles.change, change == null ? styles.muted : change >= 0 ? styles.positive : styles.negative]}>{changeText}</Text></View>;
  return <View style={styles.row}><Text numberOfLines={1} style={styles.cap}>{formatCap(snapshot.marketCapUsd)}</Text><Text numberOfLines={1} style={[styles.change, change == null ? styles.muted : change >= 0 ? styles.positive : styles.negative]}>{changeText}</Text></View>;
}
const c = kivoTheme.colors;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, minWidth: 0 },
  cap: { color: c.textMuted, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  stack: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  capStrong: { color: c.text, fontSize: 13, fontWeight: '900' },
  change: { fontSize: 12, fontWeight: '800', flexShrink: 0 },
  muted: { color: c.textMuted },
  positive: { color: '#2FD67B' },
  negative: { color: '#E57373' },
});
