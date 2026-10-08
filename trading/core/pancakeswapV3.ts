// src/core/pancakeswapV3.ts
//
// Direct, no-API-key PancakeSwap V3 fallback via their own Universal
// Router — same real motivation as uniswapV3.ts/uniswapV4.ts/
// sushiswapV2.ts (see those files' own headers). Exact port of
// mango-mobile's own src/bridge/pancakeswapV3.js — same verified
// addresses/ABI/encoding (pulled from PancakeSwap's own published npm
// packages; see that file's own header for the full verification
// trail).
//
// Deliberately scoped to Robinhood Chain ONLY, not the other chains
// this app supports — real, disclosed limitation carried over from the
// source: Robinhood Chain is the one chain where PancakeSwap's own
// published config gives a confirmed, chain-specific Permit2 address
// DIFFERENT from the canonical shared Permit2 deployment most other
// chains use, and no other chain's per-chain Permit2 address was
// independently confirmed for this integration. Extend this file the
// same way once that's confirmed for a given chain, never by assuming
// the canonical address applies.

import {encodeAbiParameters, encodePacked} from 'viem';
import {publicClientForChainId} from './chainRegistry.ts';
import {signerAndPublicClientForChain, writeContractAs} from './evmSigner.ts';
import {isNative} from './uniswapV3.ts';
import type {DerivedAccounts} from '../wallet/keys';

export const PANCAKESWAP_V3_ADDRESSES: Record<number, {factory: string; quoter: `0x${string}`; universalRouter: `0x${string}`; permit2: `0x${string}`; wrappedNative: `0x${string}`}> = {
  4663: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter: '0x8553AA1615549A86882151784b329B017aA7c832',
    universalRouter: '0xE28c0e44F4016b073db20cF28971CAc6ce3664D3',
    permit2: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768',
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  },
};

// PancakeSwap V3's own factory-enabled tiers — genuinely different from
// Uniswap V3's (500/3000/10000/100) — see this file's own header.
export const FEE_TIERS = [500, 2500, 10000, 100] as const;

// Exact amount, 30-minute Permit2 expiry — see uniswapV4.ts's matching note (audit H-03).
const PERMIT2_ALLOWANCE_TTL_SECONDS = 30 * 60;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'tokenIn', type: 'address'},
      {name: 'tokenOut', type: 'address'},
      {name: 'fee', type: 'uint24'},
      {name: 'amountIn', type: 'uint256'},
      {name: 'sqrtPriceLimitX96', type: 'uint160'},
    ],
    outputs: [{name: 'amountOut', type: 'uint256'}],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{name: 'commands', type: 'bytes'}, {name: 'inputs', type: 'bytes[]'}, {name: 'deadline', type: 'uint256'}], outputs: []},
] as const;

const ERC20_ALLOWANCE_ABI = [
  {type: 'function', name: 'allowance', inputs: [{name: 'owner', type: 'address'}, {name: 'spender', type: 'address'}], outputs: [{type: 'uint256'}], stateMutability: 'view'},
  {type: 'function', name: 'approve', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'},
] as const;

const PERMIT2_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    inputs: [{name: 'owner', type: 'address'}, {name: 'token', type: 'address'}, {name: 'spender', type: 'address'}],
    outputs: [{name: 'amount', type: 'uint160'}, {name: 'expiration', type: 'uint48'}, {name: 'nonce', type: 'uint48'}],
    stateMutability: 'view',
  },
  {type: 'function', name: 'approve', inputs: [{name: 'token', type: 'address'}, {name: 'spender', type: 'address'}, {name: 'amount', type: 'uint160'}, {name: 'expiration', type: 'uint48'}], outputs: [], stateMutability: 'nonpayable'},
] as const;

export function pancakeswapV3SupportsChain(chainId: number): boolean {
  return Boolean(PANCAKESWAP_V3_ADDRESSES[chainId]);
}

function resolvedPoolAddress(chainId: number, address: string): `0x${string}` {
  return (isNative(address) ? PANCAKESWAP_V3_ADDRESSES[chainId].wrappedNative : address) as `0x${string}`;
}

export type PancakeSwapV3Quote = {fee: number; amountOut: bigint};

/**
 * Quotes across PancakeSwap V3's own fee tiers via their Quoter's
 * quoteExactInputSingle (identical interface to Uniswap V3's own
 * QuoterV1, called read-only through simulateContract for the same
 * reason uniswapV3.ts's own quote function does).
 */
export async function quotePancakeSwapV3({chainId, tokenIn, tokenOut, amountIn}: {chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint}): Promise<PancakeSwapV3Quote | null> {
  const addresses = PANCAKESWAP_V3_ADDRESSES[chainId];
  if (!addresses) return null;
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);
  const publicClient = publicClientForChainId(chainId);

  const attempts = await Promise.allSettled(
    FEE_TIERS.map(fee =>
      publicClient
        .simulateContract({address: addresses.quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [poolTokenIn, poolTokenOut, fee, amountIn, 0n]})
        .then(({result}) => ({fee, amountOut: result})),
    ),
  );

  let best: PancakeSwapV3Quote | null = null;
  for (const attempt of attempts) {
    if (attempt.status !== 'fulfilled') continue;
    if (!best || attempt.value.amountOut > best.amountOut) {
      best = attempt.value;
    }
  }
  return best;
}

/**
 * Executes a direct PancakeSwap V3 swap through their Universal
 * Router's V3_SWAP_EXACT_IN command (byte 0) — genuinely simpler than
 * Uniswap V4's own V4Planner-actions encoding since V3 has no
 * singleton-pool/action-list concept, just a single ABI-encoded
 * (recipient, amountIn, amountOutMin, path, payerIsUser) tuple, where
 * `path` is the same packed tokenIn+fee+tokenOut bytes format Uniswap
 * V3's own Quoter.quoteExactInput uses. A native sell needs a prepended
 * WRAP_ETH command (11) — V3 pools hold ERC-20 WETH, never native value
 * directly, unlike V4 — with `value: amountIn` sent on the outer
 * execute() call. An ERC-20 sell goes through Permit2 (token -> Permit2,
 * then Permit2 -> Universal Router), same two-step approval
 * uniswapV4.ts's own header explains in full — PancakeSwap's Universal
 * Router is an explicit fork of Uniswap's, confirmed by the identical
 * execute() signature and command-byte scheme.
 */
export async function executePancakeSwapV3Swap({
  chainId,
  session,
  tokenIn,
  tokenOut,
  amountIn,
  fee,
  minAmountOut,
}: {
  chainId: number;
  session: DerivedAccounts;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  fee: number;
  minAmountOut: bigint;
}): Promise<{hash: string}> {
  const addresses = PANCAKESWAP_V3_ADDRESSES[chainId];
  if (!addresses) throw new Error(`PancakeSwap V3 isn't configured for chain ${chainId}.`);
  const {signer, publicClient} = signerAndPublicClientForChain(chainId, session);
  const tokenInIsNative = isNative(tokenIn);
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);

  if (!tokenInIsNative) {
    const erc20Allowance = (await publicClient.readContract({address: poolTokenIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance', args: [signer.address, addresses.permit2]})) as bigint;
    if (erc20Allowance < amountIn) {
      // Exact approvals can leave a remainder (a swap that failed after
      // approving); USDT-style tokens refuse non-zero -> non-zero, so reset first.
      if (erc20Allowance > 0n) {
        const resetHash = await writeContractAs(signer, {address: poolTokenIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [addresses.permit2, 0n]});
        await publicClient.waitForTransactionReceipt({hash: resetHash});
      }
      const approveHash = await writeContractAs(signer, {address: poolTokenIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [addresses.permit2, amountIn]});
      await publicClient.waitForTransactionReceipt({hash: approveHash});
    }

    const [permit2Amount, permit2Expiration] = (await publicClient.readContract({
      address: addresses.permit2,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [signer.address, poolTokenIn, addresses.universalRouter],
    })) as [bigint, number, number];
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (permit2Amount < amountIn || permit2Expiration <= nowSeconds) {
      const permit2ApproveHash = await writeContractAs(signer, {
        address: addresses.permit2,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [poolTokenIn, addresses.universalRouter, amountIn, nowSeconds + PERMIT2_ALLOWANCE_TTL_SECONDS],
      });
      await publicClient.waitForTransactionReceipt({hash: permit2ApproveHash});
    }
  }

  const path = encodePacked(['address', 'uint24', 'address'], [poolTokenIn, fee, poolTokenOut]);
  // payerIsUser=true pulls tokenIn from the account via Permit2 as part
  // of this command; payerIsUser=false spends whatever the router
  // already holds in its own balance — the case right after a WRAP_ETH
  // command deposited native value there, same standard Universal
  // Router convention this file's own header documents verifying
  // against the V4 case.
  const swapInput = encodeAbiParameters(
    [{name: 'recipient', type: 'address'}, {name: 'amountIn', type: 'uint256'}, {name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'bytes'}, {name: 'payerIsUser', type: 'bool'}],
    [signer.address, amountIn, minAmountOut, path, !tokenInIsNative],
  );

  let commands: `0x${string}`;
  let inputs: `0x${string}`[];
  if (tokenInIsNative) {
    // WRAP_ETH (11) then V3_SWAP_EXACT_IN (0) — WRAP_ETH's own params
    // are (recipient, amountMin); ADDRESS_THIS-equivalent here is
    // simply the router itself receiving the wrap, then the swap
    // command spends it — same shape Uniswap's own Universal Router
    // uses for a native sell ahead of a V3/V4 swap command.
    const wrapInput = encodeAbiParameters(
      [{name: 'recipient', type: 'address'}, {name: 'amountMin', type: 'uint256'}],
      ['0x0000000000000000000000000000000000000002', amountIn], // ADDRESS_THIS sentinel — Universal Router's own convention for "the router itself"
    );
    commands = encodePacked(['uint8', 'uint8'], [11, 0]);
    inputs = [wrapInput, swapInput];
  } else {
    commands = encodePacked(['uint8'], [0]);
    inputs = [swapInput];
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  const swapHash = await writeContractAs(signer, {
    address: addresses.universalRouter,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [commands, inputs, deadline],
    ...(tokenInIsNative ? {value: amountIn} : {}),
  });
  await publicClient.waitForTransactionReceipt({hash: swapHash});
  return {hash: swapHash};
}
