// src/core/uniswapV4.ts
//
// Direct, no-API-key Uniswap V4 fallback via Universal Router — the
// natural extension of uniswapV3.ts (see that file's own header for why
// this exists at all). Exact port of mango-mobile's own
// src/bridge/uniswapV4.js — same verified addresses/ABI/encoding
// details (see that file's own header for the full verification trail
// against Uniswap Labs' own published packages).
//
// Deliberately scoped to "vanilla" hookless pools at Uniswap's own
// standard fee-tier/tick-spacing pairings (the same 4 tiers V3 already
// tries, each with its matching default tick spacing) — a V4 pool with
// a custom hook can use ANY tick spacing and ANY hooks address, which
// isn't discoverable by bounded search at all without an off-chain
// indexer. Real, disclosed limitation, not silently assumed complete.
//
// Native currency is genuinely simpler here than in V3: V4 pools can
// hold native value directly (no WETH wrap/unwrap dance) — a native
// sell just needs `value: amountIn` on the outer execute() call, and
// PoolManager settles it without ever touching Permit2. Tried as a
// pool-key candidate ALONGSIDE the wrapped-native representation
// (below), since a real V4 pool for a given pair could have been
// created either way and there's no way to know in advance which.
//
// The ERC-20 payment path itself is confirmed to pull a non-native sell
// token through Permit2's own IAllowanceTransfer.transferFrom, NOT a
// plain ERC-20 transferFrom — this is why executeUniswapV4Swap below
// does a real two-step approval (ERC-20 -> Permit2, then Permit2 ->
// Universal Router) instead of the single approve() V3 needed —
// skipping this step doesn't fail loudly at quote time, it just reverts
// the swap itself, so it's worth getting right rather than guessing.

import {getAddress, encodeAbiParameters, encodePacked} from 'viem';
import {publicClientForChainId} from './chainRegistry.ts';
import {signerAndPublicClientForChain, writeContractAs} from './evmSigner.ts';
import {NATIVE_PLACEHOLDER, isNative, UNISWAP_V3_ADDRESSES} from './uniswapV3.ts';
import type {DerivedAccounts} from '../wallet/keys';

// Universal Router (V2.1.1) per chain — verified source in this file's
// own header. Reuses uniswapV3.ts's own chain table for
// v4PoolManager/v4Quoter/wrappedNative rather than duplicating them.
export const UNIVERSAL_ROUTER_ADDRESSES: Record<number, `0x${string}`> = {
  1: '0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA',
  10: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b',
  137: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b',
  42161: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b',
  8453: '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7',
  56: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b',
  43114: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b',
  // X Layer — Uniswap V4 Universal Router 2.1.2.
  196: '0x1cd182C94fcF42277B80DBB9060F88024809E61E',
  // Robinhood — the whole reason this file exists, same as uniswapV3.ts.
  4663: '0x8876789976decbfcbbbe364623c63652db8c0904',
  // Arc — V2.1.1, from @uniswap/universal-router-sdk 5.14.0 (chain 5042).
  5042: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
};

// Canonical Permit2 contract — SAME address on every EVM chain
// (deterministic CREATE2 deployment, confirmed against Uniswap's own
// widely-published single Permit2 address used across all their docs/
// SDKs).
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Standard fee tiers and their DEFAULT tick spacings — mirrors V3's own
// factory-enabled defaults (uniswapV3.ts's own FEE_TIERS), since that's
// the convention "vanilla" V4 pools also follow.
const FEE_TIER_TICK_SPACING = [
  {fee: 500, tickSpacing: 10},
  {fee: 3000, tickSpacing: 60},
  {fee: 10000, tickSpacing: 200},
  {fee: 100, tickSpacing: 1},
] as const;

const NO_HOOKS = '0x0000000000000000000000000000000000000000';
// Approvals are exactly this trade's amount and the Permit2 allowance
// lapses 30 minutes later (an uploaded audit's H-03, verified): these
// used to be max-uint160 to Permit2 with no expiry, plus max-uint160 to
// the router for 30 days — standing authority well past the trade.
// Permit2 decrements an exact allowance as it's spent, so nothing is
// left over after the swap either way.
const PERMIT2_ALLOWANCE_TTL_SECONDS = 30 * 60;

const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {name: 'poolKey', type: 'tuple', components: [{name: 'currency0', type: 'address'}, {name: 'currency1', type: 'address'}, {name: 'fee', type: 'uint24'}, {name: 'tickSpacing', type: 'int24'}, {name: 'hooks', type: 'address'}]},
          {name: 'zeroForOne', type: 'bool'},
          {name: 'exactAmount', type: 'uint128'},
          {name: 'hookData', type: 'bytes'},
        ],
      },
    ],
    outputs: [{name: 'amountOut', type: 'uint256'}, {name: 'gasEstimate', type: 'uint256'}],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{name: 'commands', type: 'bytes'}, {name: 'inputs', type: 'bytes[]'}, {name: 'deadline', type: 'uint256'}], outputs: []},
] as const;

const ERC20_ALLOWANCE_ABI = [
  {type: 'function', name: 'allowance', inputs: [{name: 'owner', type: 'address'}, {name: 'spender', type: 'address'}], outputs: [{type: 'uint256'}], stateMutability: 'view'},
  {type: 'function', name: 'approve', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'},
] as const;

// IAllowanceTransfer's own real shape (permit2/src/interfaces/
// IAllowanceTransfer.sol) — allowance() returns (amount, expiration,
// nonce); approve() takes (token, spender, amount, expiration).
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

export function uniswapV4SupportsChain(chainId: number): boolean {
  return Boolean(UNIVERSAL_ROUTER_ADDRESSES[chainId] && UNISWAP_V3_ADDRESSES[chainId]);
}

type PoolKey = {currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}`};

// True if currencyA sorts before currencyB under V4's own PoolKey
// ordering rule: native (the zero address) always sorts first;
// otherwise plain lowercase-address comparison.
function sortsBefore(currencyA: string, currencyB: string): boolean {
  const aNative = getAddress(currencyA) === getAddress(NATIVE_PLACEHOLDER);
  const bNative = getAddress(currencyB) === getAddress(NATIVE_PLACEHOLDER);
  if (aNative) return true;
  if (bNative) return false;
  return currencyA.toLowerCase() < currencyB.toLowerCase();
}

function buildPoolKey(currencyA: string, currencyB: string, fee: number, tickSpacing: number): {poolKey: PoolKey; zeroForOne: boolean} {
  const [currency0, currency1] = sortsBefore(currencyA, currencyB) ? [currencyA, currencyB] : [currencyB, currencyA];
  return {
    poolKey: {currency0: getAddress(currency0), currency1: getAddress(currency1), fee, tickSpacing, hooks: NO_HOOKS},
    zeroForOne: getAddress(currency0) === getAddress(currencyA),
  };
}

// A native side tries BOTH representations (real native currency, and
// the wrapped form) since a real V4 pool for a given pair could have
// been created either way — see this file's own header. A non-native
// side only ever has one real candidate: its own address.
function poolCandidates(chainId: number, address: string): string[] {
  if (!isNative(address)) return [address];
  return [NATIVE_PLACEHOLDER, UNISWAP_V3_ADDRESSES[chainId].wrappedNative];
}

export type UniswapV4Quote = {amountOut: bigint; fee: number; tickSpacing: number; poolKey: PoolKey; zeroForOne: boolean; tokenInIsNative: boolean};

/**
 * Quotes across every (fee tier x native-representation) combination via
 * V4Quoter's own quoteExactInputSingle (read-only through
 * simulateContract — same reasoning as uniswapV3.ts's own quote
 * function). Returns the best (highest amountOut) real pool found, or
 * null if this pair has no discoverable hookless pool.
 */
export async function quoteUniswapV4({chainId, tokenIn, tokenOut, amountIn}: {chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint}): Promise<UniswapV4Quote | null> {
  if (!uniswapV4SupportsChain(chainId)) return null;
  const quoterAddress = UNISWAP_V3_ADDRESSES[chainId].v4Quoter;
  const publicClient = publicClientForChainId(chainId);

  const tokenInCandidates = poolCandidates(chainId, tokenIn);
  const tokenOutCandidates = poolCandidates(chainId, tokenOut);

  const attempts: Promise<UniswapV4Quote>[] = [];
  for (const {fee, tickSpacing} of FEE_TIER_TICK_SPACING) {
    for (const candidateIn of tokenInCandidates) {
      for (const candidateOut of tokenOutCandidates) {
        if (getAddress(candidateIn) === getAddress(candidateOut)) continue;
        const {poolKey, zeroForOne} = buildPoolKey(candidateIn, candidateOut, fee, tickSpacing);
        attempts.push(
          publicClient
            .simulateContract({address: quoterAddress, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x'}]})
            .then(({result}) => ({
              amountOut: result[0],
              fee,
              tickSpacing,
              poolKey,
              zeroForOne,
              tokenInIsNative: getAddress(candidateIn) === getAddress(NATIVE_PLACEHOLDER),
            })),
        );
      }
    }
  }

  const settled = await Promise.allSettled(attempts);
  let best: UniswapV4Quote | null = null;
  for (const attempt of settled) {
    if (attempt.status !== 'fulfilled') continue;
    if (!best || attempt.value.amountOut > best.amountOut) {
      best = attempt.value;
    }
  }
  return best;
}

function encodeV4SwapActions({poolKey, zeroForOne, amountIn, minAmountOut, currencyIn, currencyOut}: {poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; minAmountOut: bigint; currencyIn: `0x${string}`; currencyOut: `0x${string}`}): `0x${string}` {
  // Actions.SWAP_EXACT_IN_SINGLE (6), SETTLE_ALL (12), TAKE_ALL (15) —
  // concatenated as raw single-byte action codes (NOT abi-encoded
  // individually) to form the `actions` bytes string V4Router's own
  // _executeActions decodes.
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [6, 12, 15]);

  // SWAP_EXACT_IN_SINGLE param (V2.1.1 struct, WITH minHopPriceX36 —
  // every Universal Router address above is a V2.1.1 deployment).
  const swapParam = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {name: 'poolKey', type: 'tuple', components: [{name: 'currency0', type: 'address'}, {name: 'currency1', type: 'address'}, {name: 'fee', type: 'uint24'}, {name: 'tickSpacing', type: 'int24'}, {name: 'hooks', type: 'address'}]},
          {name: 'zeroForOne', type: 'bool'},
          {name: 'amountIn', type: 'uint128'},
          {name: 'amountOutMinimum', type: 'uint128'},
          {name: 'minHopPriceX36', type: 'uint256'},
          {name: 'hookData', type: 'bytes'},
        ],
      },
    ],
    [{poolKey, zeroForOne, amountIn, amountOutMinimum: minAmountOut, minHopPriceX36: 0n, hookData: '0x'}],
  );

  const settleAllParam = encodeAbiParameters([{name: 'currency', type: 'address'}, {name: 'maxAmount', type: 'uint256'}], [currencyIn, amountIn]);
  const takeAllParam = encodeAbiParameters([{name: 'currency', type: 'address'}, {name: 'minAmount', type: 'uint256'}], [currencyOut, minAmountOut]);

  // V4Planner.finalize(): abi.encode(['bytes','bytes[]'], [actions, params]).
  return encodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], [actions, [swapParam, settleAllParam, takeAllParam]]);
}

/**
 * Executes a direct Uniswap V4 swap through Universal Router. For a
 * native sell, no approval step at all — value is sent directly on the
 * execute() call and V4Router settles it without touching Permit2. For
 * an ERC-20 sell, real two-step approval (see this file's own header):
 * the token -> Permit2 (a normal ERC-20 approve, skipped once already
 * max-approved) and then Permit2 -> Universal Router (Permit2's own
 * allowance record, skipped once already sufficient and unexpired).
 */
export async function executeUniswapV4Swap({
  chainId,
  session,
  tokenIn,
  amountIn,
  poolKey,
  zeroForOne,
  minAmountOut,
}: {
  chainId: number;
  session: DerivedAccounts;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolKey: PoolKey;
  zeroForOne: boolean;
  minAmountOut: bigint;
}): Promise<{hash: string}> {
  const routerAddress = UNIVERSAL_ROUTER_ADDRESSES[chainId];
  if (!routerAddress) throw new Error(`Uniswap V4 isn't configured for chain ${chainId}.`);
  const {signer, publicClient} = signerAndPublicClientForChain(chainId, session);
  const tokenInIsNative = isNative(tokenIn);
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  if (!tokenInIsNative) {
    const erc20Allowance = (await publicClient.readContract({address: currencyIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance', args: [signer.address, PERMIT2_ADDRESS]})) as bigint;
    if (erc20Allowance < amountIn) {
      // Exact approvals can leave a remainder (a swap that failed after
      // approving); USDT-style tokens refuse non-zero -> non-zero, so reset first.
      if (erc20Allowance > 0n) {
        const resetHash = await writeContractAs(signer, {address: currencyIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [PERMIT2_ADDRESS, 0n]});
        await publicClient.waitForTransactionReceipt({hash: resetHash});
      }
      const approveHash = await writeContractAs(signer, {address: currencyIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [PERMIT2_ADDRESS, amountIn]});
      await publicClient.waitForTransactionReceipt({hash: approveHash});
    }

    const [permit2Amount, permit2Expiration] = (await publicClient.readContract({address: PERMIT2_ADDRESS, abi: PERMIT2_ALLOWANCE_ABI, functionName: 'allowance', args: [signer.address, currencyIn, routerAddress]})) as [
      bigint,
      number,
      number,
    ];
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (permit2Amount < amountIn || permit2Expiration <= nowSeconds) {
      const permit2ApproveHash = await writeContractAs(signer, {
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [currencyIn, routerAddress, amountIn, nowSeconds + PERMIT2_ALLOWANCE_TTL_SECONDS],
      });
      await publicClient.waitForTransactionReceipt({hash: permit2ApproveHash});
    }
  }

  const v4Input = encodeV4SwapActions({poolKey, zeroForOne, amountIn, minAmountOut, currencyIn, currencyOut});
  // CommandType.V4_SWAP = 16 (0x10) — a single command byte, no other
  // commands needed since the ERC-20 pull (if any) already happened
  // above via Permit2, not a PERMIT2_TRANSFER_FROM command here.
  const commands = encodePacked(['uint8'], [16]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  const swapHash = await writeContractAs(signer, {
    address: routerAddress,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [commands, [v4Input], deadline],
    ...(tokenInIsNative ? {value: amountIn} : {}),
  });
  await publicClient.waitForTransactionReceipt({hash: swapHash});
  return {hash: swapHash};
}
