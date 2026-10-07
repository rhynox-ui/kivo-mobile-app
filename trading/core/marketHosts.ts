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
