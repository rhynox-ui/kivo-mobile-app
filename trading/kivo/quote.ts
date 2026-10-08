// Kivo trade ticket -> Relay quote request -> display model.
// Web buy tickets may spend any verified registry asset, not only USDC.

import {formatUnits, parseUnits} from 'viem';
import {CHAIN_LABEL, TOKEN_ADDRESSES, assetDecimalsForChain, currencyAddress, type ChainKey} from '../core/chainData';
import {getRelayQuote, intentForQuote, summarizeQuote, type RelayQuote} from '../core/relayQuote';
import {usdcDecimals} from './balances';
import {nativeSymbol, type KivoToken, type TradeSide} from './tokens';

export const QUOTE_MAX_AGE_MS = 2 * 60 * 1000;

export type QuoteAsset = {chainKey: ChainKey; address: string; symbol: string; decimals: number};

export type KivoTradeRequest = {
  side: TradeSide;
  token: KivoToken & {chainKey: ChainKey};
  /** Human amount the user typed in the selected pay asset on buy, or token amount on sell. */
  amount: string;
  userAddress: string;
  /** Buy: legacy chain selector; kept for compatibility when payAsset is omitted. */
  payChain: ChainKey;
  /** Buy: exact verified asset the user is spending. */
  payAsset?: QuoteAsset;
  tokenDecimals: number;
  slippageBps?: number;
  execution?: 'wallet' | 'gasless';
};

export type KivoQuoteView = {
  side: TradeSide; routeLabel: string; crossChain: boolean;
  pay: QuoteAsset & {amount: string; usd: number | null};
  receive: QuoteAsset & {amount: string | null; usd: number | null};
  minimumReceived: string | null; priceImpactPct: number | null; totalFeeUsd: number | null;
  fees: {gasUsd: number | null; relayerUsd: number | null; appUsd: number | null};
  etaSeconds: number | null; slippagePct: number | null; quotedAt: number; expiresAt: number;
  transactionCount: number; unsupportedReason: string | null;
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

export function nativeAsset(chainKey: ChainKey): QuoteAsset {
  const symbol = nativeSymbol(chainKey);
  return {chainKey, address: currencyAddress(chainKey, symbol), symbol, decimals: assetDecimalsForChain(chainKey, symbol) ?? 18};
}

/** Verified registry asset. Never invent an address from a symbol. */
export function verifiedAsset(chainKey: ChainKey, symbol: string): QuoteAsset {
  return {chainKey, address: currencyAddress(chainKey, symbol), symbol, decimals: assetDecimalsForChain(chainKey, symbol) ?? 18};
}

/** Where sell proceeds land: USDC on the token's chain, or native coin where no verified USDC exists. */
export function sellProceedsAsset(chainKey: ChainKey): QuoteAsset {
  if (TOKEN_ADDRESSES.USDC?.[chainKey]) return usdcAsset(chainKey);
  return nativeAsset(chainKey);
}

export function quoteAssets(request: KivoTradeRequest): {input: QuoteAsset; output: QuoteAsset} {
  const tokenAsset: QuoteAsset = {chainKey: request.token.chainKey, address: request.token.tokenAddress, symbol: request.token.symbol, decimals: request.tokenDecimals};
  return request.side === 'buy'
    ? {input: request.payAsset ?? usdcAsset(request.payChain), output: tokenAsset}
    : {input: tokenAsset, output: sellProceedsAsset(request.token.chainKey)};
}

function toBaseUnits(amount: string, decimals: number): string {
  if (parseAmountInput(amount) == null) throw new Error('Enter an amount greater than zero.');
  const [, fraction = ''] = amount.trim().split('.');
  if (fraction.length > decimals) throw new Error(`This asset supports up to ${decimals} decimal places.`);
  return parseUnits(amount.trim(), decimals).toString();
}

function num(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }

function unsupportedReasonFor(quote: RelayQuote): string | null {
  for (const step of quote.steps ?? []) {
    if (step.kind !== 'transaction') return `This route needs a "${step.kind}" step that Kivo does not sign yet. Try another amount or chain.`;
    for (const item of step.items ?? []) if (item.data?.instructions) continue; // Mobile signs Relay Solana instruction bundles with the device key.
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
  if (typeof minimumRaw === 'string' && /^\d+$/.test(minimumRaw)) { try { minimumReceived = formatUnits(BigInt(minimumRaw), outDecimals); } catch { minimumReceived = null; } }
  const tagged = intentForQuote(quote);
  const quotedAt = tagged?.quotedAt ?? Date.now();
  const slippageBps = num(details.slippageTolerance?.total);
  return {
    side: request.side,
    routeLabel: input.chainKey === output.chainKey ? CHAIN_LABEL[input.chainKey] : `${CHAIN_LABEL[input.chainKey]} → ${CHAIN_LABEL[output.chainKey]}`,
    crossChain: input.chainKey !== output.chainKey, pay: {...input, amount: request.amount.trim(), usd: summary.payAmountUsd},
    receive: {...output, amount: summary.receivedAmountFormatted, usd: summary.receiveAmountUsd}, minimumReceived,
    priceImpactPct: summary.priceImpactPct, totalFeeUsd: summary.totalFeeUsd,
    fees: {gasUsd: num(quote.fees?.gas?.amountUsd), relayerUsd: num(quote.fees?.relayer?.amountUsd ?? quote.fees?.relayerService?.amountUsd), appUsd: num(quote.fees?.app?.amountUsd)},
    etaSeconds: summary.etaSeconds, slippagePct: slippageBps == null ? null : slippageBps / 100, quotedAt, expiresAt: quotedAt + QUOTE_MAX_AGE_MS,
    transactionCount: (quote.steps ?? []).reduce((count, step) => count + (step.items ?? []).filter(item => item.status !== 'complete').length, 0),
    unsupportedReason: unsupportedReasonFor(quote),
  };
}

export async function requestKivoQuote(request: KivoTradeRequest): Promise<KivoQuote> {
  const {input, output} = quoteAssets(request);
  const amountBaseUnits = toBaseUnits(request.amount, input.decimals);
  const amountNumber = parseAmountInput(request.amount);
  const originAmountUsd = request.side === 'buy' ? amountNumber : amountNumber != null && request.token.priceUsd != null ? amountNumber * request.token.priceUsd : null;
  const quote = await getRelayQuote({
    fromChainKey: input.chainKey, toChainKey: output.chainKey, originCurrency: input.address, destinationCurrency: output.address,
    amountBaseUnits, userAddress: request.userAddress, originAmountUsd,
    ...(request.slippageBps ? {slippageTolerance: String(request.slippageBps)} : {}),
    ...(request.execution === 'gasless' ? {originGasOverhead: '80000'} : {}),
  });
  return {request, quote, input, output, view: buildQuoteView(request, quote, input, output)};
}

export function isQuoteExpired(view: Pick<KivoQuoteView, 'expiresAt'>, now = Date.now()): boolean { return now >= view.expiresAt; }

export function describeQuoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unable to get a quote.');
  if (/AMOUNT_TOO_LOW|amount too low/i.test(message)) return 'Amount is too small for this route. Try a larger amount.';
  if (/NO_SWAP_ROUTES_FOUND|no routes|NO_QUOTES/i.test(message)) return 'No route is available for this token right now. Liquidity may be too thin.';
  if (/INSUFFICIENT_LIQUIDITY/i.test(message)) return 'Not enough liquidity for this trade size.';
  if (/INVALID_INPUT_CURRENCY|INVALID_OUTPUT_CURRENCY|UNSUPPORTED_CURRENCY/i.test(message)) return 'This asset is not supported by the selected route.';
  if (/Failed to fetch|Network request failed|NetworkError/i.test(message)) return 'Could not reach the routing service. Check your connection and try again.';
  return message.length > 220 ? message.slice(0, 220) + '…' : message;
}
