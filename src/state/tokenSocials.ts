// Website / X / Telegram for a token. DexScreener only has them for tokens
// with a paid profile, so new launches (pump.fun and the like) come back
// empty there; GeckoTerminal's token info and, on Solana, Jupiter fill the gaps.

import {geckoTerminalNetworkForChainOrNull} from '@kivo/trading/core/geckoTerminalNetworks';
import type {ChainKey} from '@kivo/trading/core/chainData';
import type {TokenSocialLink} from '@kivo/trading/core/dexScreener';
const PROXY = 'https://kivo-web.pages.dev/api/market';

const cache = new Map<string, Promise<TokenSocialLink[]>>();
const HANDLE = /^[A-Za-z0-9_]{1,64}$/;

function website(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value.trim()) ? value.trim() : null;
}
/** X / Telegram from either a full https link on the right host or a bare handle. */
function social(value: unknown, kind: 'x' | 'telegram'): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim().replace(/^@/, '');
  const hosts = kind === 'x' ? /^https:\/\/(www\.)?(x|twitter)\.com\//i : /^https:\/\/(www\.)?(t\.me|telegram\.me)\//i;
  if (hosts.test(text)) return text;
  return HANDLE.test(text) ? (kind === 'x' ? `https://x.com/${text}` : `https://t.me/${text}`) : null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(10_000)});
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  }
}

async function load(chainKey: ChainKey, address: string): Promise<TokenSocialLink[]> {
  const found: Partial<Record<TokenSocialLink['kind'], string>> = {};
  const network = geckoTerminalNetworkForChainOrNull(chainKey);
  if (network) {
    type Info = {data?: {attributes?: {websites?: unknown[]; twitter_handle?: unknown; telegram_handle?: unknown}}};
    const info = await getJson<Info>(`${PROXY}/geckoterminal/api/v2/networks/${network}/tokens/${encodeURIComponent(address)}/info`);
    const attributes = info?.data?.attributes;
    found.website ??= (attributes?.websites ?? []).map(website).find(Boolean) ?? undefined;
    found.x ??= social(attributes?.twitter_handle, 'x') ?? undefined;
    found.telegram ??= social(attributes?.telegram_handle, 'telegram') ?? undefined;
  }
  if (chainKey === 'solana' && (!found.website || !found.x || !found.telegram)) {
    type Row = {id?: string; website?: unknown; twitter?: unknown; telegram?: unknown};
    const rows = await getJson<Row[]>(`${PROXY}/jupiter/tokens/v2/search?query=${encodeURIComponent(address)}`);
    const row = Array.isArray(rows) ? rows.find(item => item.id === address) : undefined;
    found.website ??= website(row?.website) ?? undefined;
    found.x ??= social(row?.twitter, 'x') ?? undefined;
    found.telegram ??= social(row?.telegram, 'telegram') ?? undefined;
  }
  return (['x', 'telegram', 'website'] as const).filter(kind => found[kind]).map(kind => ({kind, url: found[kind]!}));
}

/** DexScreener's links first; any missing kind is filled from the backups. */
export async function withSocialFallback(chainKey: ChainKey, address: string, links: Array<{kind: string; url: string}>): Promise<Array<{kind: string; url: string}>> {
  if (['x', 'telegram', 'website'].every(kind => links.some(link => link.kind === kind))) return links;
  const key = `${chainKey}:${address}`;
  if (!cache.has(key)) cache.set(key, load(chainKey, address).catch(() => []));
  const backup = await cache.get(key)!;
  return [...links, ...backup.filter(link => !links.some(existing => existing.kind === link.kind))];
}
