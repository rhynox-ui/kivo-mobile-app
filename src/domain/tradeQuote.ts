import type { TokenRef } from './types';
import type { TradeSide } from './trade';

export type TradeQuoteStatus = 'idle' | 'loading' | 'ready' | 'expired' | 'error';

export type TradeQuote = {
  id: string;
  side: TradeSide;
  input: TokenRef;
  output: TokenRef;
  inputAmount: string;
  outputAmount: string;
  minimumOutputAmount: string;
  priceImpactBps: number | null;
  feeUsd: number | null;
  gasUsd: number | null;
  estimatedSeconds: number | null;
  expiresAt: number;
};

export type TradeQuoteState =
  | { status: 'idle'; quote: null; error: null }
  | { status: 'loading'; quote: null; error: null }
  | { status: 'ready'; quote: TradeQuote; error: null }
  | { status: 'expired'; quote: TradeQuote; error: null }
  | { status: 'error'; quote: null; error: string };

export const TRADE_QUOTE_MAX_AGE_MS = 120_000;

export function isQuoteFresh(quote: TradeQuote, now = Date.now()): boolean {
  return Number.isFinite(quote.expiresAt) && quote.expiresAt > now && quote.expiresAt - now <= TRADE_QUOTE_MAX_AGE_MS;
}

export function quoteRemainingMs(quote: TradeQuote, now = Date.now()): number {
  return Math.max(0, quote.expiresAt - now);
}

export function quoteToSummary(quote: TradeQuote): {
  outputAmount: string;
  fee: string;
  impact: string;
  eta: string;
} {
  return {
    outputAmount: quote.outputAmount,
    fee: quote.feeUsd == null ? '—' : '$' + quote.feeUsd.toFixed(2),
    impact: quote.priceImpactBps == null ? '—' : (quote.priceImpactBps / 100).toFixed(2) + '%',
    eta: quote.estimatedSeconds == null ? '—' : '~' + quote.estimatedSeconds + 's',
  };
}
