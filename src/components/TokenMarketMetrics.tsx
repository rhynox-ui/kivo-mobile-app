import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { marketFetch } from '@kivo/trading/core/marketHosts';
import { kivoTheme } from '../theme/kivoTheme';

type Snapshot = { marketCapUsd: number | null; change24h: number | null };
const cache = new Map<string, Promise<Snapshot>>();
const chainIds: Record<string, string> = { solana:'solana', ethereum:'ethereum', base:'base', bnb:'bsc', robinhood:'robinhood', arbitrum:'arbitrum', avalanche:'avalanche', abstract:'abstract', hyperevm:'hyperevm', ink:'ink', plasma:'plasma', unichain:'unichain', xlayer:'xlayer', arc:'arc' };
// Not on DexScreener yet (new launches, pump.fun bonding curve): GeckoTerminal, then Jupiter for Solana.
const PROXY = 'https://kivo-web.pages.dev/api/market';
const GECKO: Record<string, string> = { ethereum: 'eth', base: 'base', bnb: 'bsc', robinhood: 'robinhood', solana: 'solana', arbitrum: 'arbitrum', avalanche: 'avax', abstract: 'abstract', hyperevm: 'hyperevm', ink: 'ink', plasma: 'plasma', unichain: 'unichain', xlayer: 'x-layer', arc: 'arc' };
const positive = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const finite = (value: unknown) => { const n = Number(value); return value != null && Number.isFinite(n) ? n : null; };

async function fromGeckoTerminal(chain: string, address: string): Promise<Snapshot | null> {
  const network = GECKO[chain.toLowerCase()];
  if (!network) return null;
  try {
    const response = await fetch(`${PROXY}/geckoterminal/api/v2/networks/${network}/tokens/${encodeURIComponent(address)}?include=top_pools`);
    if (!response.ok) return null;
    const body = await response.json();
    const cap = positive(body?.data?.attributes?.market_cap_usd) ?? positive(body?.data?.attributes?.fdv_usd);
    if (cap == null) return null;
    const pool = Array.isArray(body?.included) ? body.included.find((item: { type?: string }) => item.type === 'pool') : null;
    return { marketCapUsd: cap, change24h: finite(pool?.attributes?.price_change_percentage?.h24) };
  } catch { return null; }
}

async function fromJupiter(address: string): Promise<Snapshot | null> {
  try {
    const response = await fetch(`${PROXY}/jupiter/tokens/v2/search?query=${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const rows = await response.json();
    const token = Array.isArray(rows) ? rows.find((row: { id?: string }) => row.id === address) : null;
    const cap = positive(token?.mcap) ?? positive(token?.fdv);
    return cap == null ? null : { marketCapUsd: cap, change24h: finite(token?.stats24h?.priceChange) };
  } catch { return null; }
}

/** Live market cap and 24h change, shared (one request per token) by every card. */
export function loadSnapshot(chain: string, address: string): Promise<Snapshot> {
  const key = chain.toLowerCase() + ':' + address.toLowerCase();
  const cached = cache.get(key); if (cached) return cached;
  const request = (async (): Promise<Snapshot> => {
    try {
      const chainId = chainIds[chain.toLowerCase()];
      if (!chainId || !address) return { marketCapUsd: null, change24h: null };
      const response = await marketFetch('dexscreener', '/latest/dex/tokens/' + encodeURIComponent(address));
      if (!response.ok) return (await fromGeckoTerminal(chain, address)) ?? (chain.toLowerCase() === 'solana' ? await fromJupiter(address) : null) ?? { marketCapUsd: null, change24h: null };
      const payload = await response.json() as { pairs?: Array<{ chainId?: string; liquidity?: { usd?: number }; baseToken?: { address?: string }; marketCap?: number; priceChange?: { h24?: number } }> };
      const target = chain.toLowerCase() === 'solana' ? address : address.toLowerCase();
      const pairs = (Array.isArray(payload.pairs) ? payload.pairs : []).filter(pair => pair.chainId === chainId && (chain.toLowerCase() === 'solana' ? pair.baseToken?.address === target : pair.baseToken?.address?.toLowerCase() === target));
      pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
      const pair = pairs[0];
      if (!pair) return (await fromGeckoTerminal(chain, address)) ?? (chain.toLowerCase() === 'solana' ? await fromJupiter(address) : null) ?? { marketCapUsd: null, change24h: null };
      return { marketCapUsd: Number.isFinite(pair?.marketCap) && Number(pair?.marketCap) > 0 ? Number(pair?.marketCap) : null, change24h: Number.isFinite(pair?.priceChange?.h24) ? Number(pair?.priceChange?.h24) : null };
    } catch { return { marketCapUsd: null, change24h: null }; }
  })();
  cache.set(key, request);
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
