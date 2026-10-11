// Kivo's direct route for same-network trades: Uniswap does EVM swaps (Relay
// pays the gas, see core/directUniswap.ts) and Jupiter does Solana swaps
// (Kivo's Solana fee payer covers fees, see core/jupiter.ts). Used when the
// user's USDC is on the token's own network; everything else still goes
// through Relay.

import {formatUnits, getAddress, parseUnits, type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES} from '../core/chainData.ts';
import {viemChainForChainId} from '../core/chainRegistry.ts';
import {appFeeBps, isFeeExemptWallet, DEV_FEE_WALLET, DEV_FEE_WALLET_SOLANA} from '../core/fees.ts';
import {executeJupiterSwap, quoteJupiter, type JupiterQuote} from '../core/jupiter.ts';
import {buildDirectUniswapCalls, directUniswapSupports, quoteDirectUniswap, type DirectCall, type DirectQuote} from '../core/directUniswap.ts';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm.ts';
import type {DerivedAccounts} from '../wallet/keys';
import {usdcDecimals, type CashBalanceRow, type TokenBalance} from './balances';
import type {KivoQuoteView} from './quote';
import type {KivoToken, TradeSide} from './tokens';

/** Default slippage for direct swaps when the user left it on Auto (3%, new tokens move fast). */
const DEFAULT_SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 30_000;
/** Most Kivo ever takes from one trade (matches the server's ceiling). */
const MAX_FEE_BPS = 500n;

function feeUnits(total: bigint, amountUsd: number, extraFeeUsd: number | undefined, decimals: number, exempt = false): bigint {
  if (exempt) return 0n;
  const base = (total * BigInt(appFeeBps(amountUsd))) / 10_000n;
  const extra = extraFeeUsd && extraFeeUsd > 0 ? parseUnits(extraFeeUsd.toFixed(6), decimals) : 0n;
  const cap = (total * MAX_FEE_BPS) / 10_000n;
  return base + extra < cap ? base + extra : cap > base ? cap : base;
}

export type DirectPlan = ({
  kind: 'uniswap';
  side: TradeSide;
  quote: DirectQuote;
  minAmountOut: bigint;
  fee: {usdc: Address; amount: bigint; when: 'before' | 'after'};
  view: KivoQuoteView;
} | {
  kind: 'jupiter';
  side: TradeSide;
  quote: JupiterQuote;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  minAmountOut: bigint;
  fee: {usdc: string; amount: bigint; when: 'before' | 'after'};
  view: KivoQuoteView;
});

/** A direct Uniswap plan for this trade, or null when the trade can't go direct (then Relay is used). */
export async function planDirectTrade(params: {
  side: TradeSide; token: KivoToken; amount: number; userAddress: string; solanaAddress?: string;
  cash?: CashBalanceRow[] | null; tokenBalance?: TokenBalance | null; tokenDecimals: number; slippageBps?: number;
  /** Kivo's cost of moving this trade's USDC from Base, added to its fee (total fee stays <= 5%). */
  extraFeeUsd?: number;
}): Promise<DirectPlan | null> {
  return planSameNetwork(params);
}

async function planSameNetwork(params: Parameters<typeof planDirectTrade>[0]): Promise<DirectPlan | null> {
  const {side, token, amount, userAddress} = params;
  if (token.chainKey === 'solana') return planJupiterTrade(params);
  if (token.chainKey === 'near' || !directUniswapSupports(token.chainKey)) return null;
  const chainKey = token.chainKey;
  const usdcAddress = TOKEN_ADDRESSES.USDC?.[chainKey];
  if (!usdcAddress || token.tokenAddress.toLowerCase() === usdcAddress.toLowerCase()) return null;
  const usdc = getAddress(usdcAddress);
  const usdcDec = usdcDecimals(chainKey);
  const slippageBps = BigInt(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const exempt = isFeeExemptWallet(userAddress);

  if (side === 'buy') {
    const row = params.cash?.find(r => r.chainKey === chainKey);
    if (!row || row.status !== 'ok' || row.balance.amount + 1e-9 < amount) return null; // USDC isn't on this network
    const total = parseUnits(amount.toFixed(Math.min(usdcDec, 6)), usdcDec);
    const fee = feeUnits(total, amount, params.extraFeeUsd, usdcDec, exempt);
    const quote = await quoteDirectUniswap({chainKey, tokenIn: usdc, tokenOut: token.tokenAddress, amountIn: total - fee});
    if (!quote) return null;
    const minAmountOut = (quote.amountOut * (10_000n - slippageBps)) / 10_000n;
    const out = Number(formatUnits(quote.amountOut, params.tokenDecimals));
    return {kind: 'uniswap', side, quote, minAmountOut, fee: {usdc, amount: fee, when: 'before'},
      view: viewFor({side, token, payAmount: amount, payUsd: amount, receiveAmount: out, receiveUsd: token.priceUsd != null ? out * token.priceUsd : null,
        minimum: formatUnits(minAmountOut, params.tokenDecimals), feeUsd: Number(formatUnits(fee, usdcDec)), slippageBps, payDecimals: usdcDec, receiveDecimals: params.tokenDecimals, usdc})};
  }

  const balance = params.tokenBalance;
  if (!balance) return null;
  const sellUnits = parseUnits(String(amount), balance.decimals);
  if (sellUnits <= 0n || sellUnits > balance.raw) return null;
  const quote = await quoteDirectUniswap({chainKey, tokenIn: token.tokenAddress, tokenOut: usdc, amountIn: sellUnits});
  if (!quote) return null;
  const minAmountOut = (quote.amountOut * (10_000n - slippageBps)) / 10_000n;
  const outUsd = Number(formatUnits(quote.amountOut, usdcDec));
  const fee = exempt ? 0n : (minAmountOut * BigInt(appFeeBps(outUsd))) / 10_000n;
  return {kind: 'uniswap', side, quote, minAmountOut, fee: {usdc, amount: fee, when: 'after'},
    view: viewFor({side, token, payAmount: amount, payUsd: token.priceUsd != null ? amount * token.priceUsd : outUsd, receiveAmount: outUsd - Number(formatUnits(fee, usdcDec)), receiveUsd: outUsd - Number(formatUnits(fee, usdcDec)),
      minimum: formatUnits(minAmountOut - fee, usdcDec), feeUsd: Number(formatUnits(fee, usdcDec)), slippageBps, payDecimals: balance.decimals, receiveDecimals: usdcDec, usdc})};
}

async function planJupiterTrade(params: {
  side: TradeSide; token: KivoToken; amount: number; userAddress: string; solanaAddress?: string;
  cash?: CashBalanceRow[] | null; tokenBalance?: TokenBalance | null; tokenDecimals: number; slippageBps?: number;
  /** Kivo's cost of moving this trade's USDC from Base, added to its fee (total fee stays <= 5%). */
  extraFeeUsd?: number;
}): Promise<DirectPlan | null> {
  const {side, token, amount} = params;
  const usdcMint = TOKEN_ADDRESSES.USDC?.solana;
  if (!usdcMint || token.tokenAddress === usdcMint) return null;
  const slippage = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (side === 'buy') {
    const row = params.cash?.find(r => r.chainKey === 'solana');
    if (!row || row.status !== 'ok' || row.balance.amount + 1e-9 < amount) return null; // USDC isn't on Solana
    const total = parseUnits(amount.toFixed(6), 6);
    const fee = feeUnits(total, amount, params.extraFeeUsd, 6);
    const quote = await quoteJupiter({inputMint: usdcMint, outputMint: token.tokenAddress, amount: total - fee, slippageBps: slippage});
    if (!quote) return null;
    const out = Number(formatUnits(BigInt(quote.outAmount), params.tokenDecimals));
    const minAmountOut = BigInt(quote.otherAmountThreshold);
    return {kind: 'jupiter', side, quote, inputMint: usdcMint, outputMint: token.tokenAddress, amountIn: total - fee, minAmountOut, fee: {usdc: usdcMint, amount: fee, when: 'before'},
      view: viewFor({side, token, payAmount: amount, payUsd: amount, receiveAmount: out, receiveUsd: token.priceUsd != null ? out * token.priceUsd : null,
        minimum: formatUnits(minAmountOut, params.tokenDecimals), feeUsd: Number(formatUnits(fee, 6)), slippageBps: BigInt(slippage), payDecimals: 6, receiveDecimals: params.tokenDecimals, usdc: usdcMint as Address, routeLabel: 'Jupiter'})};
  }
  const balance = params.tokenBalance;
  if (!balance) return null;
  const sellUnits = parseUnits(String(amount), balance.decimals);
  if (sellUnits <= 0n || sellUnits > balance.raw) return null;
  const quote = await quoteJupiter({inputMint: token.tokenAddress, outputMint: usdcMint, amount: sellUnits, slippageBps: slippage});
  if (!quote) return null;
  const minAmountOut = BigInt(quote.otherAmountThreshold);
  const outUsd = Number(formatUnits(BigInt(quote.outAmount), 6));
  const fee = (minAmountOut * BigInt(appFeeBps(outUsd))) / 10_000n;
  const net = outUsd - Number(formatUnits(fee, 6));
  return {kind: 'jupiter', side, quote, inputMint: token.tokenAddress, outputMint: usdcMint, amountIn: sellUnits, minAmountOut, fee: {usdc: usdcMint, amount: fee, when: 'after'},
    view: viewFor({side, token, payAmount: amount, payUsd: token.priceUsd != null ? amount * token.priceUsd : outUsd, receiveAmount: net, receiveUsd: net,
      minimum: formatUnits(minAmountOut - fee, 6), feeUsd: Number(formatUnits(fee, 6)), slippageBps: BigInt(slippage), payDecimals: balance.decimals, receiveDecimals: 6, usdc: usdcMint as Address, routeLabel: 'Jupiter'})};
}

function viewFor(x: {side: TradeSide; token: KivoToken; payAmount: number; payUsd: number | null; receiveAmount: number; receiveUsd: number | null; minimum: string; feeUsd: number; slippageBps: bigint; payDecimals: number; receiveDecimals: number; usdc: Address; routeLabel?: string}): KivoQuoteView {
  const chainKey = x.token.chainKey as Exclude<KivoToken['chainKey'], 'near'>;
  const tokenAsset = {chainKey, address: x.token.tokenAddress, symbol: x.token.symbol, decimals: x.side === 'buy' ? x.receiveDecimals : x.payDecimals};
  const usdcAsset = {chainKey, address: x.usdc, symbol: 'USDC', decimals: x.side === 'buy' ? x.payDecimals : x.receiveDecimals};
  const impact = x.payUsd && x.receiveUsd != null && x.payUsd > 0 ? Math.max(0, (1 - x.receiveUsd / x.payUsd) * 100) : null;
  const now = Date.now();
  return {
    side: x.side, routeLabel: x.routeLabel ?? 'Uniswap', crossChain: false,
    pay: {...(x.side === 'buy' ? usdcAsset : tokenAsset), amount: String(x.payAmount), usd: x.payUsd},
    receive: {...(x.side === 'buy' ? tokenAsset : usdcAsset), amount: String(x.receiveAmount), usd: x.receiveUsd},
    minimumReceived: x.minimum, priceImpactPct: impact, totalFeeUsd: x.feeUsd,
    fees: {gasUsd: 0, relayerUsd: 0, appUsd: x.feeUsd},
    etaSeconds: 5, slippagePct: Number(x.slippageBps) / 100, quotedAt: now, expiresAt: now + QUOTE_TTL_MS,
    transactionCount: 1, unsupportedReason: null,
  };
}

/** Signs and sends the direct trade as one gasless batch. */
export async function executeDirectPlan(plan: DirectPlan, session: DerivedAccounts): Promise<{txHashes: string[]; requestId: string | null; chainIds: number[]}> {
  if (plan.kind === 'jupiter') {
    const buy = plan.side === 'buy';
    const {signature} = await executeJupiterSwap({
      quote: plan.quote, secretKeyBase58: session.solana.privateKey,
      fee: {usdcMint: plan.fee.usdc, units: plan.fee.amount, when: plan.fee.when, wallet: DEV_FEE_WALLET_SOLANA},
      // The wallet may only spend the trade's input (plus Kivo's fee) and must receive at least the minimum.
      spendIntent: buy
        ? {spend: plan.inputMint.toLowerCase(), maxSpend: plan.amountIn + plan.fee.amount, expectedOutputMint: plan.outputMint.toLowerCase(), expectedOutputMinimum: plan.minAmountOut}
        : {spend: plan.inputMint.toLowerCase(), maxSpend: plan.amountIn, expectedOutputMint: plan.outputMint.toLowerCase(), expectedOutputMinimum: plan.minAmountOut - plan.fee.amount},
    });
    return {txHashes: [signature], requestId: null, chainIds: [792703809]};
  }
  const chain = viemChainForChainId(plan.quote.chainId);
  if (!chain) throw new Error('This network is not available for direct trades.');
  const account = privateKeyToAccount(session.evm.privateKey as `0x${string}`);
  const calls: DirectCall[] = buildDirectUniswapCalls({
    quote: plan.quote, user: account.address, minAmountOut: plan.minAmountOut, feeWallet: getAddress(DEV_FEE_WALLET),
    ...(plan.fee.when === 'before' ? {feeBefore: plan.fee} : {feeAfter: plan.fee}),
  });
  const result = await sendEvmCallsViaRelayGasless({chain, fromAddress: account.address, account, calls});
  return {txHashes: [result.hash], requestId: result.requestId, chainIds: [plan.quote.chainId]};
}
