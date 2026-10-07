import type { TokenRef } from '../domain/types';
import type { TradeQuote } from '../domain/tradeQuote';

export type QuoteRequest = {
  side: 'buy' | 'sell';
  input: TokenRef;
  output: TokenRef;
  amount: string;
  slippageBps: number;
};

export type QuoteProvider = {
  getQuote(request: QuoteRequest): Promise<TradeQuote>;
};

/**
 * Adapter boundary only. The UI/domain layer depends on this contract, not on
 * a specific routing provider. Provider credentials, RPC access and signing
 * must stay below this boundary.
 */
export function validateQuoteRequest(request: QuoteRequest): string | null {
  if (!request.input.address || !request.output.address) return 'Trade assets are not fully identified.';
  const amount = request.amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) return 'Trade amount must be greater than zero.';
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 5000) return 'Slippage must be between 0 and 50%.';
  return null;
}

export async function requestQuote(provider: QuoteProvider, request: QuoteRequest): Promise<TradeQuote> {
  const error = validateQuoteRequest(request);
  if (error) throw new Error(error);
  return provider.getQuote(request);
}

export function createQuoteRequest(
  side: QuoteRequest['side'],
  input: TokenRef,
  output: TokenRef,
  amount: string,
  slippageBps = 100,
): QuoteRequest {
  return { side, input, output, amount, slippageBps };
}
