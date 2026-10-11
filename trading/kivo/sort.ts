import type {KivoToken} from './tokens';

// Mango Pro's token-list sort, over the list already on screen. Every field is
// real market data the list already loaded; a token missing that field always
// goes last. 'default' keeps each list's own ranking (trending order, search relevance).
export const TOKEN_SORT_OPTIONS = [
  {key: 'default', label: 'Default'},
  {key: 'mcapDesc', label: 'Market cap: high to low'},
  {key: 'mcapAsc', label: 'Market cap: low to high'},
  {key: 'changeDesc', label: '24h change: gainers first'},
  {key: 'changeAsc', label: '24h change: losers first'},
  {key: 'volumeDesc', label: 'Most volume (24h)'},
  {key: 'txDesc', label: 'Most transactions (24h)'},
  {key: 'liqDesc', label: 'Most liquidity'},
  {key: 'ageNewest', label: 'Pair age: newest first'},
  {key: 'ageOldest', label: 'Pair age: oldest first'},
] as const;
export type TokenSortKey = (typeof TOKEN_SORT_OPTIONS)[number]['key'];

export function isTokenSortKey(value: unknown): value is TokenSortKey {
  return TOKEN_SORT_OPTIONS.some(option => option.key === value);
}

export function sortTokens<T extends KivoToken>(tokens: T[], sort: TokenSortKey): T[] {
  if (sort === 'default') return tokens;
  const field = (token: T): number | null | undefined => {
    switch (sort) {
      case 'mcapDesc': case 'mcapAsc': return token.marketCapUsd;
      case 'changeDesc': case 'changeAsc': return token.change24h;
      case 'volumeDesc': return token.volumeUsd24h;
      case 'txDesc': return token.txCount24h;
      case 'liqDesc': return token.liquidityUsd;
      case 'ageNewest': case 'ageOldest': return token.createdAt;
    }
  };
  const ascending = sort === 'mcapAsc' || sort === 'changeAsc' || sort === 'ageOldest';
  return [...tokens].sort((a, b) => {
    const x = field(a), y = field(b);
    const xOk = x != null && Number.isFinite(x), yOk = y != null && Number.isFinite(y);
    if (!xOk || !yOk) return xOk === yOk ? 0 : xOk ? -1 : 1;
    // ageNewest: larger timestamp first.
    return ascending ? x - y : y - x;
  });
}
