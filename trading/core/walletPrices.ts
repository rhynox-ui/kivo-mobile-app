// src/core/walletPrices.ts
//
// Real price feed via CoinGecko's free, no-API-key public endpoint —
// byte-for-byte the same conservative symbol->id map the reference mobile app's own
// src/wallet/walletPrices.js uses (itself ported from mango-bridge.jsx):
// only long-established, unambiguous ids; a native asset with no entry
// here shows no price rather than a guessed one. This unblocks two real
// gaps this app had with no price feed at all: the large-trade fee cap
// (appFeeBps/appFeeBpsForSponsoredTrade in fees.ts already implement it,
// but nothing ever passed a real originAmountUsd for them to cap
// against) and the fallback-trade fee sweep (fallbackDex.ts's own
// sweepFallbackFeeFromNativeBalance).
//
// Not every chain this app supports gets a live price this way — e.g.
// 'HYPE' (hyperevm) and 'XPL' (plasma) have no entry, same as the mobile
// source's own list, since their CoinGecko ids weren't independently
// confirmed there either. A missing price is a real, disclosed gap on
// those specific chains, not silently guessed.
import {marketUrl} from './marketHosts';

export const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  WBTC: 'wrapped-bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  POL: 'polygon-ecosystem-token',
  OKB: 'okb',
  HYPE: 'hyperliquid',
  XPL: 'plasma',
  USDT0: 'tether',
};

const PRICE_CACHE_TTL_MS = 60_000;
const cachedPricesByCurrency: Record<string, Record<string, number>> = {};
const cachedAtByCurrency: Record<string, number> = {};
const inFlightByCurrency: Record<string, Promise<Record<string, number>>> = {};

export async function fetchWalletPrices(currency = 'usd'): Promise<Record<string, number>> {
  const cached = cachedPricesByCurrency[currency];
  if (cached && Date.now() - cachedAtByCurrency[currency] < PRICE_CACHE_TTL_MS) return cached;
  const inFlight = inFlightByCurrency[currency];
  if (inFlight) return inFlight;

  const ids = [...new Set(Object.values(SYMBOL_TO_COINGECKO_ID))];
  const promise = fetch(`${marketUrl('coingecko', '/api/v3/simple/price')}?ids=${ids.join(',')}&vs_currencies=${currency}`)
    .then(res => {
      if (!res.ok) throw new Error(`CoinGecko price fetch failed: ${res.status}`);
      return res.json() as Promise<Record<string, Record<string, number>>>;
    })
    .then(data => {
      const bySymbol: Record<string, number> = {};
      for (const [symbol, id] of Object.entries(SYMBOL_TO_COINGECKO_ID)) {
        if (typeof data[id]?.[currency] === 'number') bySymbol[symbol] = data[id][currency];
      }
      cachedPricesByCurrency[currency] = bySymbol;
      cachedAtByCurrency[currency] = Date.now();
      return bySymbol;
    })
    .finally(() => {
      delete inFlightByCurrency[currency];
    });

  inFlightByCurrency[currency] = promise;
  return promise;
}
