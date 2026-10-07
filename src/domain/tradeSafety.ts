import type { TradeIntent } from './trade';
import type { TradeQuote } from './tradeQuote';
import { isQuoteFresh } from './tradeQuote';

export const MAX_SLIPPAGE_BPS = 5000;
export const MAX_PRICE_IMPACT_BPS = 2000;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

export function normalizeDecimal(value: string): string { return value.trim().replace(/,/g, ''); }
export function isPositiveDecimal(value: string): boolean {
  const normalized = normalizeDecimal(value);
  if (!DECIMAL_RE.test(normalized)) return false;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0;
}
export function validSlippageBps(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= MAX_SLIPPAGE_BPS; }
export function validPriceImpact(quote: TradeQuote): boolean {
  return quote.priceImpactBps == null || (Number.isFinite(quote.priceImpactBps) && quote.priceImpactBps >= 0 && quote.priceImpactBps <= MAX_PRICE_IMPACT_BPS);
}
export function quoteMatchesIntent(quote: TradeQuote, intent: TradeIntent): boolean {
  return quote.side === intent.side &&
    quote.input.address.toLowerCase() === intent.inputToken.address.toLowerCase() &&
    quote.output.address.toLowerCase() === intent.outputToken.address.toLowerCase() &&
    quote.input.chainId === intent.inputToken.chainId &&
    quote.output.chainId === intent.outputToken.chainId &&
    quote.inputAmount === normalizeDecimal(intent.amount);
}
export function canSignQuote(quote: TradeQuote, intent: TradeIntent, now = Date.now()): boolean {
  return isQuoteFresh(quote, now) && validPriceImpact(quote) && quoteMatchesIntent(quote, intent);
}
export function minimumOutputIsSafe(quote: TradeQuote): boolean {
  const min = Number(quote.minimumOutputAmount);
  const out = Number(quote.outputAmount);
  return Number.isFinite(min) && Number.isFinite(out) && min >= 0 && min <= out;
}
export function quoteHasValidAmounts(quote: TradeQuote): boolean {
  return isPositiveDecimal(quote.inputAmount) && isPositiveDecimal(quote.outputAmount) && minimumOutputIsSafe(quote);
}
export function executionGate(quote: TradeQuote, intent: TradeIntent, now = Date.now()): string | null {
  if (!canSignQuote(quote, intent, now)) return 'Quote is stale or does not match the current trade intent.';
  if (!quoteHasValidAmounts(quote)) return 'Quote amounts are invalid.';
  if (!validSlippageBps(intent.slippageBps)) return 'Slippage setting is invalid.';
  return null;
}
export function sanitizeSlippageBps(value: number, fallback = 100): number {
  return validSlippageBps(value) ? value : fallback;
}
export function quoteAgeMs(quote: TradeQuote, now = Date.now()): number {
  return Math.max(0, now - (quote.expiresAt - 120_000));
}
