// src/core/uniswapV3.ts
//
// Direct, no-API-key Uniswap V3 fallback: calls the real, public
// QuoterV1 and SwapRouter02 contracts on-chain, the same way any other
// DeFi client does — no account, no signup, no key to rotate, and
// nothing to proxy through a backend (unlike fallbackDex.ts's two
// generic providers, 1inch/0x, which both need a real developer API key
// this app can't safely ship inside a decompilable mobile APK — see
// that file's own header). Exact port of mango-mobile's own
// src/bridge/uniswapV3.js, same verified addresses (pulled from Uniswap
// Labs' own published @uniswap/sdk-core npm package — see that file's
// own header for the full verification trail) and same logic, adapted
// to viem's TS types and this app's own chainRegistry.ts helpers.
//
// V3 only in this file — V4 uses a singleton PoolManager with an
// unlock/callback pattern and no direct external swap entrypoint (it
// needs its own periphery router on top, Universal Router) — see
// uniswapV4.ts for that materially different integration.

import {getAddress} from 'viem';
import {publicClientForChainId} from './chainRegistry.ts';
import {signerAndPublicClientForChain, writeContractAs} from './evmSigner.ts';
import type {DerivedAccounts} from '../wallet/keys';

export const NATIVE_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

export type UniswapV3ChainAddresses = {
  factory: string;
  quoter: `0x${string}`;
  swapRouter02: `0x${string}`;
  wrappedNative: `0x${string}`;
  v4PoolManager: string;
  v4Quoter: `0x${string}`;
  v4StateView: string;
};

// chainId -> real, verified contract addresses. See this file's own
// header for exactly where every one of these came from (unchanged from
// mango-mobile's own already-verified table).
export const UNISWAP_V3_ADDRESSES: Record<number, UniswapV3ChainAddresses> = {
  1: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4Quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
    v4StateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  },
  10: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    v4PoolManager: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
    v4Quoter: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7',
    v4StateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
  },
  137: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    v4PoolManager: '0x67366782805870060151383f4bbff9dab53e5cd6',
    v4Quoter: '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9',
    v4StateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
  },
  42161: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    v4PoolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    v4Quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
    v4StateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  },
  8453: {
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    v4PoolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    v4Quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
    v4StateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  },
  56: {
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    swapRouter02: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    v4PoolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    v4Quoter: '0x9f75dd27d6664c475b90e105573e550ff69437b0',
    v4StateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
  },
  43114: {
    factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    quoter: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    swapRouter02: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    v4PoolManager: '0x06380c0e0912312b5150364b9dc4542ba0dbbc85',
    v4Quoter: '0xbe40675bb704506a3c2ccfb762dcfd1e979845c2',
    v4StateView: '0xc3c9e198c735a4b97e3e683f391ccbdd60b69286',
  },
  // Robinhood — the whole reason this file exists (see this file's own
  // header): the only chain in this app's own EVM coverage with
  // genuinely no other fallback route at all.
  4663: {
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
    swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  },
  // Arc — Uniswap's official Arc deployment (v3 + v4), from
  // @uniswap/sdk-core 7.19.4 ARC_ADDRESSES (same values the site uses).
  // Arc has no WETH: its gas coin is USDC and pools hold the 6-decimal
  // ERC-20 view of it (ARC_USDC). This app never routes Arc USDC as the
  // native placeholder (chainData's NATIVE_PLACEHOLDER_BY_CHAIN.arc is
  // ARC_USDC), so the wrap/unwrap paths are never taken on Arc; pointing
  // wrappedNative at the same ERC-20 keeps a stray native quote on the
  // right pools and makes a stray native execution fail in simulation.
  196: {
    factory: '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804',
    quoter: '0xd1b797d92d87b688193a2b976efc8d577d204343',
    swapRouter02: '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca',
    wrappedNative: '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
    v4PoolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    v4Quoter: '0x8928074ca1b241d8ec02815881c1af11e8bc5219',
    v4StateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  },
  5042: {
    factory: '0xf0db7b58379503491d857db50ac9ece64c653918',
    quoter: '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',
    swapRouter02: '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77',
    wrappedNative: '0x3600000000000000000000000000000000000000',
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  },
};

// The standard fee tiers Uniswap V3's factory enables by default
// (hundredths of a bip). Tried in this order when the caller doesn't
// already know which tier a pair's real pool uses — QuoterV1's own
// quoteExactInputSingle reverts for a tier with no pool, so most tiers
// are expected to fail; only "no pool at any tier" surfaces as null.
export const FEE_TIERS = [500, 3000, 10000, 100] as const;

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

// X Layer publishes Uniswap V3 QuoterV2, whose quoteExactInputSingle
// takes the packed parameter tuple and returns the richer V2 result tuple.
const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        {name: 'tokenIn', type: 'address'},
        {name: 'tokenOut', type: 'address'},
        {name: 'amountIn', type: 'uint256'},
        {name: 'fee', type: 'uint24'},
        {name: 'sqrtPriceLimitX96', type: 'uint160'},
      ],
    }],
    outputs: [
      {name: 'amountOut', type: 'uint256'},
      {name: 'sqrtPriceX96After', type: 'uint160'},
      {name: 'initializedTicksCrossed', type: 'uint32'},
      {name: 'gasEstimate', type: 'uint256'},
    ],
  },
] as const;

const SWAP_ROUTER_02_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {name: 'tokenIn', type: 'address'},
          {name: 'tokenOut', type: 'address'},
          {name: 'fee', type: 'uint24'},
          {name: 'recipient', type: 'address'},
          {name: 'amountIn', type: 'uint256'},
          {name: 'amountOutMinimum', type: 'uint256'},
          {name: 'sqrtPriceLimitX96', type: 'uint160'},
        ],
      },
    ],
    outputs: [{name: 'amountOut', type: 'uint256'}],
  },
] as const;

// Real, universal WETH9-shaped wrap ABI — same 4-byte selector on every
// EVM chain's canonical wrapped-native contract, not specific to any one
// deployment.
const WRAPPED_NATIVE_ABI = [{type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: []}] as const;

const ERC20_ALLOWANCE_ABI = [
  {type: 'function', name: 'allowance', inputs: [{name: 'owner', type: 'address'}, {name: 'spender', type: 'address'}], outputs: [{type: 'uint256'}], stateMutability: 'view'},
  {type: 'function', name: 'approve', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'},
] as const;

export function uniswapV3SupportsChain(chainId: number): boolean {
  return Boolean(UNISWAP_V3_ADDRESSES[chainId]);
}

// Exported for direct verify-script coverage — this exact check decides
// whether a swap wraps native value first, so it's real application
// logic worth testing on its own, not just indirectly.
export function isNative(address: string): boolean {
  return getAddress(address) === getAddress(NATIVE_PLACEHOLDER);
}

// A selling side that's this chain's native asset trades as the
// wrapped-native contract on Uniswap V3 (pools don't hold native value
// directly) — resolved here, wrapped for real in executeUniswapV3Swap
// below. A buying side that's native is deliberately NOT unwrapped back:
// the swap simply delivers the wrapped-native token to the recipient's
// own wallet, same disclosed trade-off already accepted for Solana's own
// WSOL handling elsewhere in this app family.
function resolvedPoolAddress(chainId: number, address: string): `0x${string}` {
  return (isNative(address) ? UNISWAP_V3_ADDRESSES[chainId].wrappedNative : getAddress(address)) as `0x${string}`;
}

export type UniswapV3Quote = {fee: number; amountOut: bigint};

/**
 * Quotes across this chain's standard fee tiers via QuoterV1's own
 * quoteExactInputSingle (called read-only through simulateContract —
 * it's not a `view` function on-chain, but nothing needs a real signer
 * or gas to read its return value this way). Returns the best (highest
 * amountOut) real tier found, or null if no pool exists for this pair
 * at any of them.
 */
export async function quoteUniswapV3({chainId, tokenIn, tokenOut, amountIn}: {chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint}): Promise<UniswapV3Quote | null> {
  const addresses = UNISWAP_V3_ADDRESSES[chainId];
  if (!addresses) return null;
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);
  const publicClient = publicClientForChainId(chainId);

  const attempts = await Promise.allSettled(
    FEE_TIERS.map(fee =>
      publicClient
        .simulateContract({
          address: addresses.quoter,
          abi: chainId === 196 ? QUOTER_V2_ABI : QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args:
            chainId === 196
              ? [{tokenIn: poolTokenIn, tokenOut: poolTokenOut, amountIn, fee, sqrtPriceLimitX96: 0n}]
              : [poolTokenIn, poolTokenOut, fee, amountIn, 0n],
        })
        .then(({result}) => ({fee, amountOut: typeof result === 'bigint' ? result : result[0]})),
    ),
  );

  let best: UniswapV3Quote | null = null;
  for (const attempt of attempts) {
    if (attempt.status !== 'fulfilled') continue;
    if (!best || attempt.value.amountOut > best.amountOut) {
      best = attempt.value;
    }
  }
  return best;
}

/**
 * Executes a direct Uniswap V3 swap: wraps native input first if needed
 * (a real, separate on-chain deposit() call — never a multicall guess
 * at SwapRouter02's own native-handling behavior, which isn't
 * consistent enough across deployments to assume), then approves the
 * router for an ERC-20 sell (skipped for a just-wrapped-native sell —
 * the router itself needs the ALLOWANCE, so this still runs even after
 * wrapping), then exactInputSingle.
 */
export async function executeUniswapV3Swap({
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
  const addresses = UNISWAP_V3_ADDRESSES[chainId];
  if (!addresses) throw new Error(`Uniswap V3 isn't configured for chain ${chainId}.`);
  const {signer, publicClient} = signerAndPublicClientForChain(chainId, session);
  const poolTokenIn = resolvedPoolAddress(chainId, tokenIn);
  const poolTokenOut = resolvedPoolAddress(chainId, tokenOut);

  if (isNative(tokenIn)) {
    const wrapHash = await writeContractAs(signer, {address: addresses.wrappedNative, abi: WRAPPED_NATIVE_ABI, functionName: 'deposit', value: amountIn});
    await publicClient.waitForTransactionReceipt({hash: wrapHash});
  }

  const currentAllowance = (await publicClient.readContract({
    address: poolTokenIn,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [signer.address, addresses.swapRouter02],
  })) as bigint;
  if (currentAllowance < amountIn) {
    const approveHash = await writeContractAs(signer, {address: poolTokenIn, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [addresses.swapRouter02, amountIn]});
    await publicClient.waitForTransactionReceipt({hash: approveHash});
  }

  const swapHash = await writeContractAs(signer, {
    address: addresses.swapRouter02,
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [{tokenIn: poolTokenIn, tokenOut: poolTokenOut, fee, recipient: signer.address, amountIn, amountOutMinimum: minAmountOut, sqrtPriceLimitX96: 0n}],
  });
  await publicClient.waitForTransactionReceipt({hash: swapHash});
  return {hash: swapHash};
}
