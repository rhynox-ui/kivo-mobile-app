// Base URLs for the public market-data services the engine reads.
//
// Defaults are the services themselves. A client can route them through
// its own server instead (configureMarketHosts): the web app does, because
// some browsers, in-app browsers and tracker blockers refuse direct calls
// to these hosts, which looks to users like "search finds nothing".

export type MarketService = 'dexscreener' | 'geckoterminal' | 'goplus' | 'coingecko';

const DEFAULT_HOSTS: Record<MarketService, string> = {
  dexscreener: 'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com',
  goplus: 'https://api.gopluslabs.io',
  coingecko: 'https://api.coingecko.com',
};

let hosts: Record<MarketService, string> = {...DEFAULT_HOSTS};

export function configureMarketHosts(next: Partial<Record<MarketService, string>>): void {
  hosts = {...hosts, ...next};
}

/** `path` starts with "/", e.g. marketUrl('dexscreener', '/latest/dex/search?q=pepe'). */
export function marketUrl(service: MarketService, path: string): string {
  return hosts[service].replace(/\/$/, '') + path;
}

function isProxied(service: MarketService): boolean {
  return hosts[service].replace(/\/$/, '') !== DEFAULT_HOSTS[service];
}

const busy = (response: Response) => response.status === 429 || response.status >= 500;

/**
 * fetch() for market data, the way mango-bridge does it: straight to the
 * provider from the user's own connection first (each user has their own
 * rate-limit budget there). When that is blocked (tracker blockers, in-app
 * browsers) or rate limited, it falls back to the configured proxy, which
 * shares one budget but caches and keeps the last good answer. Answers are
 * never invented: if both fail, the last real response or error is returned.
 */
export async function marketFetch(service: MarketService, path: string, init?: RequestInit): Promise<Response> {
  const direct = DEFAULT_HOSTS[service] + path;
  if (!isProxied(service)) return fetch(direct, init);
  let first: Response | null = null;
  try {
    first = await fetch(direct, init);
    if (!busy(first)) return first;
  } catch {
    // Blocked or offline — try the proxy.
  }
  try {
    const proxied = await fetch(marketUrl(service, path), init);
    return proxied.ok || !first ? proxied : first;
  } catch (error) {
    if (first) return first;
    throw error;
  }
}
