// src/core/sushiswapV2.ts
//
// Direct, no-API-key SushiSwap V2 fallback — same real motivation and
// verification discipline as uniswapV3.ts (see that file's own header).
// Exact port of mango-mobile's own src/bridge/sushiswapV2.js.
//
// Genuinely simpler than uniswapV3.ts/uniswapV4.ts: SushiSwap's V2
// router is a direct fork of Uniswap's own V2 Router02 (identical
// interface, unchanged since 2020) — one router per chain, a plain
// `view` function for quoting (no simulateContract trick needed the way
// V3's Quoter/V4's V4Quoter require), and the router handles native-
// asset wrap/unwrap internally via its own ETH-suffixed functions — no
// separate manual wrap step the way uniswapV3.ts needs.
//
// Every address below came from SushiSwap's own actively-maintained
// `sushi` npm package — see the mobile source file's own header for the
// full verification trail.
//
// The FeeOnTransferTokens router variants are used deliberately rather
// than the plain ones: a custom pasted-CA token (the whole reason a
// second-source fallback exists at all) could easily be a fee-on-
// transfer token, and the FeeOnTransfer variants handle both that and
// an ordinary token correctly, while the plain variants can revert or
// misprice a fee-on-transfer one.
//
// Deliberately direct-pair only (path = [tokenIn, tokenOut], no multi-
// hop through an intermediate token) — same bounded-scope discipline as
// uniswapV3.ts's fee-tier search: a real, disclosed limitation, not
// silently assumed to cover every pair.

import {getAddress} from 'viem';
import {publicClientForChainId} from './chainRegistry.ts';
import {signerAndPublicClientForChain, writeContractAs} from './evmSigner.ts';
import {isNative, UNISWAP_V3_ADDRESSES} from './uniswapV3.ts';
import type {DerivedAccounts} from '../wallet/keys';

// chainId -> real, verified SushiSwap V2 addresses. wrappedNative is NOT
// duplicated here — it's the same contract regardless of which DEX
// trades it, so this reuses uniswapV3.ts's own per-chain table.
export const SUSHISWAP_V2_ADDRESSES: Record<number, {factory: string; router: `0x${string}`}> = {
  1: {factory: '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', router: '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f'},
  10: {factory: '0xfbc12984689e5f15626bad03ad60160fe98b303c', router: '0x2abf469074dc0b54d793850807e6eb5faf2625b1'},
  137: {factory: '0xc35dadb65012ec5796536bd9864ed8773abc74c4', router: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'},
  42161: {factory: '0xc35dadb65012ec5796536bd9864ed8773abc74c4', router: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'},
  8453: {factory: '0x71524b4f93c58fcbf659783284e38825f0622859', router: '0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891'},
  56: {factory: '0xc35dadb65012ec5796536bd9864ed8773abc74c4', router: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'},
  43114: {factory: '0xc35dadb65012ec5796536bd9864ed8773abc74c4', router: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'},
  // Robinhood — the whole reason this file exists, same as uniswapV3.ts.
  4663: {factory: '0xe52abd50ad151ecdf56427effd715e703696a6b1', router: '0x9a55d3d0c0f09859c7869510f53ed0a30b340766'},
};

const ROUTER_ABI = [
  {type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{name: 'amountIn', type: 'uint256'}, {name: 'path', type: 'address[]'}], outputs: [{name: 'amounts', type: 'uint256[]'}]},
  {
    type: 'function',
    name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [{name: 'amountIn', type: 'uint256'}, {name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'payable',
    inputs: [{name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [{name: 'amountIn', type: 'uint256'}, {name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}],
    outputs: [],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {type: 'function', name: 'allowance', inputs: [{name: 'owner', type: 'address'}, {name: 'spender', type: 'address'}], outputs: [{type: 'uint256'}], stateMutability: 'view'},
  {type: 'function', name: 'approve', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'},
] as const;

export function sushiswapV2SupportsChain(chainId: number): boolean {
  return Boolean(SUSHISWAP_V2_ADDRESSES[chainId]);
}

function poolAddress(chainId: number, address: string): `0x${string}` {
  return (isNative(address) ? UNISWAP_V3_ADDRESSES[chainId].wrappedNative : getAddress(address)) as `0x${string}`;
}

export type SushiSwapV2Quote = {amountOut: bigint; path: [`0x${string}`, `0x${string}`]};

/**
 * Direct-pair quote via the router's own real getAmountsOut — a plain
 * view function, so this is a single call, not a bounded search across
 * fee tiers the way V3/V4 need (V2 has exactly one pool per pair, no
 * fee-tier concept at all). Returns null if no pool exists for this
 * exact pair.
 */
export async function quoteSushiSwapV2({chainId, tokenIn, tokenOut, amountIn}: {chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint}): Promise<SushiSwapV2Quote | null> {
  if (!sushiswapV2SupportsChain(chainId)) return null;
  const {router} = SUSHISWAP_V2_ADDRESSES[chainId];
  const path: [`0x${string}`, `0x${string}`] = [poolAddress(chainId, tokenIn), poolAddress(chainId, tokenOut)];
  const publicClient = publicClientForChainId(chainId);
  try {
    const amounts = (await publicClient.readContract({address: router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path]})) as bigint[];
    return {amountOut: amounts[amounts.length - 1], path};
  } catch {
    // No pool for this exact pair — same "not found, not necessarily an
    // error" handling uniswapV3.ts's own quote function uses.
    return null;
  }
}

/**
 * Executes a direct SushiSwap V2 swap. No manual wrap/unwrap step
 * (unlike uniswapV3.ts) — the router's own ETH-suffixed functions
 * handle native value internally. An ERC-20 sell still needs a plain
 * approve() to the router (V2's own long-standing model, not Permit2 —
 * that's V4/PancakeSwap-V3-specific, see uniswapV4.ts's own header for
 * why those needed the extra step this file doesn't).
 */
export async function executeSushiSwapV2Swap({
  chainId,
  session,
  tokenIn,
  tokenOut,
  amountIn,
  minAmountOut,
}: {
  chainId: number;
  session: DerivedAccounts;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
}): Promise<{hash: string}> {
  const addresses = SUSHISWAP_V2_ADDRESSES[chainId];
  if (!addresses) throw new Error(`SushiSwap V2 isn't configured for chain ${chainId}.`);
  const {signer, publicClient} = signerAndPublicClientForChain(chainId, session);
  const tokenInIsNative = isNative(tokenIn);
  const tokenOutIsNative = isNative(tokenOut);
  const path: [`0x${string}`, `0x${string}`] = [poolAddress(chainId, tokenIn), poolAddress(chainId, tokenOut)];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  let swapHash: string;
  if (tokenInIsNative) {
    swapHash = await writeContractAs(signer, {
      address: addresses.router,
      abi: ROUTER_ABI,
      functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
      args: [minAmountOut, path, signer.address, deadline],
      value: amountIn,
    });
  } else {
    const tokenInAddress = getAddress(tokenIn) as `0x${string}`;
    const currentAllowance = (await publicClient.readContract({address: tokenInAddress, abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance', args: [signer.address, addresses.router]})) as bigint;
    if (currentAllowance < amountIn) {
      const approveHash = await writeContractAs(signer, {address: tokenInAddress, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [addresses.router, amountIn]});
      await publicClient.waitForTransactionReceipt({hash: approveHash});
    }
    swapHash = await writeContractAs(signer, {
      address: addresses.router,
      abi: ROUTER_ABI,
      functionName: tokenOutIsNative ? 'swapExactTokensForETHSupportingFeeOnTransferTokens' : 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [amountIn, minAmountOut, path, signer.address, deadline],
    });
  }
  await publicClient.waitForTransactionReceipt({hash: swapHash as `0x${string}`});
  return {hash: swapHash};
}
