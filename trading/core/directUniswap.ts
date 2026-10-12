// Same-network trades straight on Uniswap, with Relay paying the gas.
//
// The swap itself is a plain Uniswap router call (V3 SwapRouter02 single
// pool or two pools through the wrapped native coin, or a V4 pool through
// Universal Router). Kivo's fee is a USDC transfer to Kivo's fee wallet in
// the same batch. The whole batch is signed by the user's wallet and sent
// gaslessly through Relay's /execute (EIP-7702 Calibur), via Kivo's server,
// which checks every call before Kivo pays the gas.
//
// The batch is atomic: if the price moved past the minimum received, the
// swap reverts and nothing happens (no fee taken, nothing spent).

import {encodeFunctionData, encodePacked, getAddress, type Address, type Hex} from 'viem';
import {MAINNET_CHAIN_IDS, TOKEN_ADDRESSES, type ChainKey} from './chainData.ts';
import {publicClientForChainId} from './chainRegistry.ts';
import {UNISWAP_V3_ADDRESSES, FEE_TIERS, quoteUniswapV3} from './uniswapV3.ts';
import {PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESSES, encodeV4SwapActions, quoteUniswapV4, type PoolKey} from './uniswapV4.ts';

export type DirectRoute =
  | {kind: 'v3-single'; fee: number}
  | {kind: 'v3-path'; path: Hex}
  | {kind: 'v4'; poolKey: PoolKey; zeroForOne: boolean};

export type DirectQuote = {chainId: number; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint; route: DirectRoute};

const QUOTE_EXACT_INPUT_V1 = [{type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable', inputs: [{name: 'path', type: 'bytes'}, {name: 'amountIn', type: 'uint256'}], outputs: [{name: 'amountOut', type: 'uint256'}]}] as const;
const QUOTE_EXACT_INPUT_V2 = [{type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable', inputs: [{name: 'path', type: 'bytes'}, {name: 'amountIn', type: 'uint256'}], outputs: [{name: 'amountOut', type: 'uint256'}, {name: 'sqrtPriceX96AfterList', type: 'uint160[]'}, {name: 'initializedTicksCrossedList', type: 'uint32[]'}, {name: 'gasEstimate', type: 'uint256'}]}] as const;
const SWAP_ROUTER_02 = [
  {type: 'function', name: 'exactInputSingle', stateMutability: 'payable', inputs: [{name: 'params', type: 'tuple', components: [{name: 'tokenIn', type: 'address'}, {name: 'tokenOut', type: 'address'}, {name: 'fee', type: 'uint24'}, {name: 'recipient', type: 'address'}, {name: 'amountIn', type: 'uint256'}, {name: 'amountOutMinimum', type: 'uint256'}, {name: 'sqrtPriceLimitX96', type: 'uint160'}]}], outputs: [{name: 'amountOut', type: 'uint256'}]},
  {type: 'function', name: 'exactInput', stateMutability: 'payable', inputs: [{name: 'params', type: 'tuple', components: [{name: 'path', type: 'bytes'}, {name: 'recipient', type: 'address'}, {name: 'amountIn', type: 'uint256'}, {name: 'amountOutMinimum', type: 'uint256'}]}], outputs: [{name: 'amountOut', type: 'uint256'}]},
] as const;
const ERC20 = [
  {type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{name: 'to', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}]},
] as const;
const PERMIT2 = [{type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{name: 'token', type: 'address'}, {name: 'spender', type: 'address'}, {name: 'amount', type: 'uint160'}, {name: 'expiration', type: 'uint48'}], outputs: []}] as const;
const UNIVERSAL_ROUTER = [{type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{name: 'commands', type: 'bytes'}, {name: 'inputs', type: 'bytes[]'}, {name: 'deadline', type: 'uint256'}], outputs: []}] as const;

export function directUniswapSupports(chainKey: ChainKey): boolean {
  if (chainKey === 'solana') return false;
  const chainId = MAINNET_CHAIN_IDS[chainKey];
  return Boolean(TOKEN_ADDRESSES.USDC?.[chainKey]) && Boolean(UNISWAP_V3_ADDRESSES[chainId] || UNIVERSAL_ROUTER_ADDRESSES[chainId]);
}

function v3Path(tokens: Address[], fees: number[]): Hex {
  const types: string[] = [];
  const values: unknown[] = [];
  tokens.forEach((token, i) => {
    types.push('address'); values.push(token);
    if (i < fees.length) { types.push('uint24'); values.push(fees[i]); }
  });
  return encodePacked(types, values);
}

/** Best Uniswap output for exactly `amountIn` of tokenIn -> tokenOut on one network, or null. ERC-20s only. */
export async function quoteDirectUniswap({chainKey, tokenIn, tokenOut, amountIn}: {chainKey: ChainKey; tokenIn: string; tokenOut: string; amountIn: bigint}): Promise<DirectQuote | null> {
  if (!directUniswapSupports(chainKey) || amountIn <= 0n) return null;
  const chainId = MAINNET_CHAIN_IDS[chainKey];
  const tin = getAddress(tokenIn), tout = getAddress(tokenOut);
  const v3 = UNISWAP_V3_ADDRESSES[chainId];
  const candidates: Promise<DirectQuote | null>[] = [];

  if (v3) {
    candidates.push(quoteUniswapV3({chainId, tokenIn: tin, tokenOut: tout, amountIn}).then(q => q && q.amountOut > 0n ? {chainId, tokenIn: tin, tokenOut: tout, amountIn, amountOut: q.amountOut, route: {kind: 'v3-single', fee: q.fee} as DirectRoute} : null).catch(() => null));
    // Most new tokens pool against the wrapped native coin, not USDC: two pools.
    const wrapped = getAddress(v3.wrappedNative);
    if (wrapped !== tin && wrapped !== tout) {
      const client = publicClientForChainId(chainId);
      const abi = chainId === 196 ? QUOTE_EXACT_INPUT_V2 : QUOTE_EXACT_INPUT_V1;
      for (const usdcFee of [500, 3000]) {
        for (const tokenFee of FEE_TIERS) {
          const fees = tin === getAddress(TOKEN_ADDRESSES.USDC![chainKey]!) ? [usdcFee, tokenFee] : [tokenFee, usdcFee];
          const path = v3Path([tin, wrapped, tout], fees);
          candidates.push(client.simulateContract({address: v3.quoter, abi, functionName: 'quoteExactInput', args: [path, amountIn]})
            .then(({result}) => {
              const out = typeof result === 'bigint' ? result : (result as unknown as readonly [bigint])[0];
              return out > 0n ? {chainId, tokenIn: tin, tokenOut: tout, amountIn, amountOut: out, route: {kind: 'v3-path', path} as DirectRoute} : null;
            }).catch(() => null));
        }
      }
    }
  }
  if (UNIVERSAL_ROUTER_ADDRESSES[chainId]) {
    candidates.push(quoteUniswapV4({chainId, tokenIn: tin, tokenOut: tout, amountIn})
      .then(q => q && q.amountOut > 0n && !q.tokenInIsNative ? {chainId, tokenIn: tin, tokenOut: tout, amountIn, amountOut: q.amountOut, route: {kind: 'v4', poolKey: q.poolKey, zeroForOne: q.zeroForOne} as DirectRoute} : null)
      .catch(() => null));
  }
  const results = (await Promise.all(candidates)).filter((q): q is DirectQuote => q !== null);
  return results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))[0] ?? null;
}

export type DirectCall = {to: Address; value: bigint; data: Hex};

/**
 * The batch for one direct trade. Buy: fee (USDC) first, then swap the rest.
 * Sell: swap, then pay the fee in USDC out of the guaranteed minimum.
 */
export function buildDirectUniswapCalls(params: {
  quote: DirectQuote; user: Address; minAmountOut: bigint; feeWallet: Address;
  /** USDC fee taken before the swap (buys). amountIn already excludes it. */
  feeBefore?: {usdc: Address; amount: bigint};
  /** USDC fee paid after the swap (sells). */
  feeAfter?: {usdc: Address; amount: bigint};
}): DirectCall[] {
  const {quote, user, minAmountOut, feeWallet} = params;
  const calls: DirectCall[] = [];
  const call = (to: Address, data: Hex): void => { calls.push({to, value: 0n, data}); };
  if (params.feeBefore && params.feeBefore.amount > 0n) call(params.feeBefore.usdc, encodeFunctionData({abi: ERC20, functionName: 'transfer', args: [feeWallet, params.feeBefore.amount]}));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  if (quote.route.kind === 'v4') {
    const router = UNIVERSAL_ROUTER_ADDRESSES[quote.chainId];
    const {poolKey, zeroForOne} = quote.route;
    const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
    const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    call(quote.tokenIn, encodeFunctionData({abi: ERC20, functionName: 'approve', args: [getAddress(PERMIT2_ADDRESS), quote.amountIn]}));
    call(getAddress(PERMIT2_ADDRESS), encodeFunctionData({abi: PERMIT2, functionName: 'approve', args: [quote.tokenIn, getAddress(router), quote.amountIn, Math.floor(Date.now() / 1000) + 30 * 60]}));
    const input = encodeV4SwapActions({poolKey, zeroForOne, amountIn: quote.amountIn, minAmountOut, currencyIn, currencyOut});
    call(getAddress(router), encodeFunctionData({abi: UNIVERSAL_ROUTER, functionName: 'execute', args: [encodePacked(['uint8'], [16]), [input], deadline]}));
  } else {
    const router = getAddress(UNISWAP_V3_ADDRESSES[quote.chainId].swapRouter02);
    call(quote.tokenIn, encodeFunctionData({abi: ERC20, functionName: 'approve', args: [router, quote.amountIn]}));
    call(router, quote.route.kind === 'v3-single'
      ? encodeFunctionData({abi: SWAP_ROUTER_02, functionName: 'exactInputSingle', args: [{tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, fee: quote.route.fee, recipient: user, amountIn: quote.amountIn, amountOutMinimum: minAmountOut, sqrtPriceLimitX96: 0n}]})
      : encodeFunctionData({abi: SWAP_ROUTER_02, functionName: 'exactInput', args: [{path: quote.route.path, recipient: user, amountIn: quote.amountIn, amountOutMinimum: minAmountOut}]}));
  }
  if (params.feeAfter && params.feeAfter.amount > 0n) call(params.feeAfter.usdc, encodeFunctionData({abi: ERC20, functionName: 'transfer', args: [feeWallet, params.feeAfter.amount]}));
  return calls;
}
