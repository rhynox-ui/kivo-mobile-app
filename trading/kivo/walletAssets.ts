// Holdings from Mango's wallet-asset indexer (tokens received from outside
// Kivo). The indexer is one source among several: callers must treat a
// failure here as "this source is unavailable", never as an empty wallet.
import type {TradeChain} from '../core/chainData';

export type WalletAsset = {key: string; chainKey: TradeChain; address: string; symbol: string; name: string; decimals: number; amount: number; valueUsd: number | null; priceUsd: number | null; imageUrl: string | null; isNative: boolean};
export type WalletAssetsResult = {holdings: WalletAsset[]; totalValueUsd: number; complete: boolean; partialErrors: Array<{provider?: string; error?: string; network?: string}>};

const ENDPOINT = 'https://mangoprotocol.site/api/v1/pro/wallet-assets';
const CACHE_TTL_MS = 20_000;
/** A hung indexer must not hold the whole portfolio: give up after this long. */
const FETCH_TIMEOUT_MS = 12_000;

function sanitize(a: any): WalletAsset | null {
  if (!a || typeof a.chainKey !== 'string' || typeof a.address !== 'string') return null;
  const decimals = Number(a.decimals);
  const amount = Number(a.amount);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !Number.isFinite(amount) || amount < 0) return null;
  const valueUsd = a.valueUsd == null ? null : Number(a.valueUsd);
  const priceUsd = a.priceUsd == null ? null : Number(a.priceUsd);
  return {
    ...a,
    symbol: typeof a.symbol === 'string' && a.symbol.trim() ? a.symbol.trim() : 'UNKNOWN',
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'UNKNOWN',
    decimals,
    amount,
    valueUsd: valueUsd != null && Number.isFinite(valueUsd) && valueUsd >= 0 ? valueUsd : null,
    priceUsd: priceUsd != null && Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : null,
    imageUrl: typeof a.imageUrl === 'string' ? a.imageUrl : null,
    isNative: Boolean(a.isNative),
  };
}

// Cache and in-flight requests are keyed by the exact wallet addresses, so a
// wallet switch never receives the previous wallet's holdings.
const cache = new Map<string, {value: WalletAssetsResult; at: number}>();
const inFlight = new Map<string, Promise<WalletAssetsResult>>();

function cacheKey(evmAddress: string, solanaAddress: string, nearAddress: string | null): string {
  return `${evmAddress.toLowerCase()}:${solanaAddress}:${nearAddress ?? ''}`;
}

async function request(evmAddress: string, solanaAddress: string, nearAddress: string | null): Promise<WalletAssetsResult> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({evmAddress, solanaAddress, nearAddress}),
      ...(controller ? {signal: controller.signal} : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Wallet asset index failed: ${response.status}`);
    const holdings = Array.isArray(payload?.holdings) ? (payload.holdings.map(sanitize).filter(Boolean) as WalletAsset[]) : [];
    const total = Number(payload?.totalValueUsd);
    return {
      holdings,
      totalValueUsd: Number.isFinite(total) && total >= 0 ? total : 0,
      complete: payload?.complete === true,
      partialErrors: Array.isArray(payload?.partialErrors) ? payload.partialErrors : [],
    };
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('Wallet asset index timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWalletAssets(evmAddress: string, solanaAddress: string, nearAddress: string | null = null, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<WalletAssetsResult> {
  const key = cacheKey(evmAddress, solanaAddress, nearAddress);
  if (!forceFresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }
  const promise = request(evmAddress, solanaAddress, nearAddress).then(value => {
    cache.set(key, {value, at: Date.now()});
    return value;
  });
  inFlight.set(key, promise);
  const clear = () => { if (inFlight.get(key) === promise) inFlight.delete(key); };
  promise.then(clear, clear);
  return promise;
}
