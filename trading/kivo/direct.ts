// Kivo's direct route for same-network trades: Uniswap does the swap, Relay
// pays the gas (see core/directUniswap.ts). Used when the user's USDC is on
// the token's own network; everything else still goes through Relay.

import {formatUnits, getAddress, parseUnits, type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES} from '../core/chainData.ts';
import {viemChainForChainId} from '../core/chainRegistry.ts';
import {appFeeBps, isFeeExemptWallet, DEV_FEE_WALLET} from '../core/fees.ts';
import {buildDirectUniswapCalls, directUniswapSupports, quoteDirectUniswap, type DirectCall, type DirectQuote} from '../core/directUniswap.ts';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm.ts';
import type {DerivedAccounts} from '../wallet/keys';
import {usdcDecimals, type CashBalanceRow, type TokenBalance} from './balances';
import type {KivoQuoteView} from './quote';
import type {KivoToken, TradeSide} from './tokens';

/** Default slippage for direct swaps when the user left it on Auto (3%, new tokens move fast). */
const DEFAULT_SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 30_000;

export type DirectPlan = {
  kind: 'uniswap';
  side: TradeSide;
  quote: DirectQuote;
  minAmountOut: bigint;
  fee: {usdc: Address; amount: bigint; when: 'before' | 'after'};
  view: KivoQuoteView;
};

/** A direct Uniswap plan for this trade, or null when the trade can't go direct (then Relay is used). */
export async function planDirectTrade(params: {
  side: TradeSide; token: KivoToken; amount: number; userAddress: string;
  cash?: CashBalanceRow[] | null; tokenBalance?: TokenBalance | null; tokenDecimals: number; slippageBps?: number;
}): Promise<DirectPlan | null> {
  const {side, token, amount, userAddress} = params;
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
    const fee = exempt ? 0n : (total * BigInt(appFeeBps(amount))) / 10_000n;
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

function viewFor(x: {side: TradeSide; token: KivoToken; payAmount: number; payUsd: number | null; receiveAmount: number; receiveUsd: number | null; minimum: string; feeUsd: number; slippageBps: bigint; payDecimals: number; receiveDecimals: number; usdc: Address}): KivoQuoteView {
  const chainKey = x.token.chainKey as Exclude<KivoToken['chainKey'], 'near'>;
  const tokenAsset = {chainKey, address: x.token.tokenAddress, symbol: x.token.symbol, decimals: x.side === 'buy' ? x.receiveDecimals : x.payDecimals};
  const usdcAsset = {chainKey, address: x.usdc, symbol: 'USDC', decimals: x.side === 'buy' ? x.payDecimals : x.receiveDecimals};
  const impact = x.payUsd && x.receiveUsd != null && x.payUsd > 0 ? Math.max(0, (1 - x.receiveUsd / x.payUsd) * 100) : null;
  const now = Date.now();
  return {
    side: x.side, routeLabel: 'Uniswap', crossChain: false,
    pay: {...(x.side === 'buy' ? usdcAsset : tokenAsset), amount: String(x.payAmount), usd: x.payUsd},
    receive: {...(x.side === 'buy' ? tokenAsset : usdcAsset), amount: String(x.receiveAmount), usd: x.receiveUsd},
    minimumReceived: x.minimum, priceImpactPct: impact, totalFeeUsd: x.feeUsd,
    fees: {gasUsd: 0, relayerUsd: 0, appUsd: x.feeUsd},
    etaSeconds: 5, slippagePct: Number(x.slippageBps) / 100, quotedAt: now, expiresAt: now + QUOTE_TTL_MS,
    transactionCount: 1, unsupportedReason: null,
  };
}

/** Signs and sends the direct trade as one gasless batch. */
export async function executeDirectPlan(plan: DirectPlan, session: DerivedAccounts): Promise<{txHashes: string[]; requestId: string; chainIds: number[]}> {
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
