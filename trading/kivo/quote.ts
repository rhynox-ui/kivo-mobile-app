// Kivo trade ticket -> Relay quote request -> display model.
//
// This is the only place either client builds a quote. It calls the
// ported engine's getRelayQuote() unchanged (same fee, intent tagging and
// re-quote behaviour), so the intent firewall later checks the signed
// transactions against exactly what this function asked for.

import {formatUnits, parseUnits} from 'viem';
import {CHAIN_LABEL, TOKEN_ADDRESSES, currencyAddress, type ChainKey} from '../core/chainData';
import {getRelayQuote, intentForQuote, summarizeQuote, type RelayQuote} from '../core/relayQuote';
import {usdcDecimals} from './balances';
import {nativeSymbol, type KivoToken, type TradeSide} from './tokens';

/** Matches the engine's own signing freshness window (core/executeRelayQuote RELAY_QUOTE_MAX_AGE_MS). */
export const QUOTE_MAX_AGE_MS = 2 * 60 * 1000;

export type QuoteAsset = {chainKey: ChainKey; address: string; symbol: string; decimals: number};

export type KivoTradeRequest = {
  side: TradeSide;
  token: KivoToken & {chainKey: ChainKey};
  /** Human amount the user typed: USDC to spend on a buy, tokens to sell on a sell. */
  amount: string;
  /** Wallet address that will sign. Comes from the live wallet session, never from profile data. */
  userAddress: string;
  /** Buy: chain whose USDC pays. Sell: ignored (proceeds land as USDC on the token's chain). */
  payChain: ChainKey;
  /** Sell: the token's on-chain decimals, read from the contract. */
  tokenDecimals: number;
  /** Relay slippage in basis points, or undefined for Relay's own Auto. */
  slippageBps?: number;
  /**
   * How the trade will be signed. 'wallet' (web): the user's own wallet
   * sends each transaction and pays network gas. 'gasless' (mobile): the
   * device wallet signs one EIP-7702 batch and Relay submits it with Kivo
   * covering gas, so the quote reserves Calibur's execution overhead.
   */
  execution?: 'wallet' | 'gasless';
};

export type KivoQuoteView = {
  side: TradeSide;
  routeLabel: string;
  crossChain: boolean;
  pay: QuoteAsset & {amount: string; usd: number | null};
  receive: QuoteAsset & {amount: string | null; usd: number | null};
  minimumReceived: string | null;
  priceImpactPct: number | null;
  totalFeeUsd: number | null;
  fees: {gasUsd: number | null; relayerUsd: number | null; appUsd: number | null};
  etaSeconds: number | null;
  slippagePct: number | null;
  quotedAt: number;
  expiresAt: number;
  transactionCount: number;
  /** Set when the route needs something Kivo will not sign (signature steps, Solana items). */
  unsupportedReason: string | null;
};

export type KivoQuote = {request: KivoTradeRequest; quote: RelayQuote; view: KivoQuoteView; input: QuoteAsset; output: QuoteAsset};

export function parseAmountInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function usdcAsset(chainKey: ChainKey): QuoteAsset {
  return {chainKey, address: currencyAddress(chainKey, 'USDC'), symbol: 'USDC', decimals: usdcDecimals(chainKey)};
}

/** Where sell proceeds land: USDC on the token's chain, or the native coin where Kivo has no verified USDC. */
export function sellProceedsAsset(chainKey: ChainKey): QuoteAsset {
  if (TOKEN_ADDRESSES.USDC?.[chainKey]) return usdcAsset(chainKey);
  const symbol = nativeSymbol(chainKey);
  return {chainKey, address: currencyAddress(chainKey, symbol), symbol, decimals: 18};
}

export function quoteAssets(request: KivoTradeRequest): {input: QuoteAsset; output: QuoteAsset} {
  const tokenAsset: QuoteAsset = {chainKey: request.token.chainKey, address: request.token.tokenAddress, symbol: request.token.symbol, decimals: request.tokenDecimals};
  return request.side === 'buy'
    ? {input: usdcAsset(request.payChain), output: tokenAsset}
    : {input: tokenAsset, output: sellProceedsAsset(request.token.chainKey)};
}

function toBaseUnits(amount: string, decimals: number): string {
  if (parseAmountInput(amount) == null) throw new Error('Enter an amount greater than zero.');
  const [, fraction = ''] = amount.trim().split('.');
  if (fraction.length > decimals) throw new Error(`This asset supports up to ${decimals} decimal places.`);
  return parseUnits(amount.trim(), decimals).toString();
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unsupportedReasonFor(quote: RelayQuote): string | null {
  for (const step of quote.steps ?? []) {
    if (step.kind !== 'transaction') return `This route needs a "${step.kind}" step that Kivo does not sign yet. Try another amount or chain.`;
    for (const item of step.items ?? []) {
      if (item.data?.instructions) return 'This route includes a Solana transaction. Kivo currently signs EVM transactions only.';
    }
  }
  if (!(quote.steps ?? []).some(step => (step.items ?? []).length > 0)) return 'The route returned no transactions to sign.';
  return null;
}

export function buildQuoteView(request: KivoTradeRequest, quote: RelayQuote, input: QuoteAsset, output: QuoteAsset): KivoQuoteView {
  const summary = summarizeQuote(quote, output.decimals);
  const details = quote.details ?? {};
  const outDecimals = details.currencyOut?.currency?.decimals ?? output.decimals;
  let minimumReceived: string | null = null;
  const minimumRaw = details.currencyOut?.minimumAmount;
  if (typeof minimumRaw === 'string' && /^\d+$/.test(minimumRaw)) {
    try { minimumReceived = formatUnits(BigInt(minimumRaw), outDecimals); } catch { minimumReceived = null; }
  }
  const tagged = intentForQuote(quote);
  const quotedAt = tagged?.quotedAt ?? Date.now();
  const slippageBps = num(details.slippageTolerance?.total);
  return {
    side: request.side,
    routeLabel: input.chainKey === output.chainKey ? CHAIN_LABEL[input.chainKey] : `${CHAIN_LABEL[input.chainKey]} → ${CHAIN_LABEL[output.chainKey]}`,
    crossChain: input.chainKey !== output.chainKey,
    pay: {...input, amount: request.amount.trim(), usd: summary.payAmountUsd},
    receive: {...output, amount: summary.receivedAmountFormatted, usd: summary.receiveAmountUsd},
    minimumReceived,
    priceImpactPct: summary.priceImpactPct,
    totalFeeUsd: summary.totalFeeUsd,
    fees: {
      gasUsd: num(quote.fees?.gas?.amountUsd),
      relayerUsd: num(quote.fees?.relayer?.amountUsd ?? quote.fees?.relayerService?.amountUsd),
      appUsd: num(quote.fees?.app?.amountUsd),
    },
    etaSeconds: summary.etaSeconds,
    slippagePct: slippageBps == null ? null : slippageBps / 100,
    quotedAt,
    expiresAt: quotedAt + QUOTE_MAX_AGE_MS,
    transactionCount: (quote.steps ?? []).reduce((count, step) => count + (step.items ?? []).filter(item => item.status !== 'complete').length, 0),
    unsupportedReason: unsupportedReasonFor(quote),
  };
}

/** Requests a live Relay route through the engine. Throws with Relay's real error text on failure. */
export async function requestKivoQuote(request: KivoTradeRequest): Promise<KivoQuote> {
  const {input, output} = quoteAssets(request);
  const amountBaseUnits = toBaseUnits(request.amount, input.decimals);
  const amountNumber = parseAmountInput(request.amount);
  const originAmountUsd = request.side === 'buy' ? amountNumber : amountNumber != null && request.token.priceUsd != null ? amountNumber * request.token.priceUsd : null;
  const quote = await getRelayQuote({
    fromChainKey: input.chainKey,
    toChainKey: output.chainKey,
    originCurrency: input.address,
    destinationCurrency: output.address,
    amountBaseUnits,
    userAddress: request.userAddress,
    originAmountUsd,
    ...(request.slippageBps ? {slippageTolerance: String(request.slippageBps)} : {}),
    // Same value Mango Pro and Relay's own 7702 example use for Calibur's execute() wrapper.
    ...(request.execution === 'gasless' ? {originGasOverhead: '80000'} : {}),
  });
  return {request, quote, input, output, view: buildQuoteView(request, quote, input, output)};
}

export function isQuoteExpired(view: Pick<KivoQuoteView, 'expiresAt'>, now = Date.now()): boolean {
  return now >= view.expiresAt;
}

/** Turns Relay's raw error text into something a user can act on, keeping the original for support. */
export function describeQuoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unable to get a quote.');
  if (/AMOUNT_TOO_LOW|amount too low/i.test(message)) return 'Amount is too small for this route. Try a larger amount.';
  if (/NO_SWAP_ROUTES_FOUND|no routes|NO_QUOTES/i.test(message)) return 'No route is available for this token right now. Liquidity may be too thin.';
  if (/INSUFFICIENT_LIQUIDITY/i.test(message)) return 'Not enough liquidity for this trade size.';
  if (/Failed to fetch|Network request failed|NetworkError/i.test(message)) return 'Could not reach the routing service. Check your connection and try again.';
  return message.length > 220 ? message.slice(0, 220) + '…' : message;
}
