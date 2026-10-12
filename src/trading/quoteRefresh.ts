import type { TradeQuote } from '../domain/tradeQuote';
import { isQuoteFresh } from '../domain/tradeQuote';

export function shouldRefreshQuote(quote: TradeQuote | null, now = Date.now()): boolean {
  return quote == null || !isQuoteFresh(quote, now);
}
