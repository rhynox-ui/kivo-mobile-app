// src/core/fallbackTxFirewall.ts
//
// The pre-sign check for the generic fallback aggregators (1inch, 0x) —
// found valid in an uploaded audit (C-01): fallbackDex.ts signed the
// provider's own `to`, `data`, `value` and approval spender as returned,
// checked only by an eth_call, which proves a transaction runs, not that
// it's the trade the user asked for. A compromised quote proxy could have
// pointed `to` at any token the wallet holds with transfer calldata.
//
// Now every generic fallback transaction must be exactly the trade:
//   - `to` and the approval spender are the provider's canonical
//     contract: 1inch's AggregationRouterV6, 0x's AllowanceHolder;
//   - native value is the amount being sold on a native sale, zero
//     otherwise;
//   - the calldata is decoded (only the functions these providers use for
//     a plain swap; anything else is refused) and must spend exactly the
//     sell token and amount, pay the wallet itself, and enforce an
//     on-chain minimum within MAX_FALLBACK_SLIPPAGE_BPS of the quote.
//   - For 0x, the Settler contract AllowanceHolder hands the tokens to
//     must be the one 0x's own on-chain registry names (checked in
//     fallbackDex.ts — see assertZeroExSettlerRegistered), per 0x's own
//     integration rules.
// ABIs and addresses were confirmed against the providers' published
// sources (function selectors hashed and matched: 1inch swap 0x07ed2379,
// unoswap 0x83800a8e; 0x exec 0x2213bc0b, Settler execute 0x1fff991f;
// 0x-settler README for AllowanceHolder and the registry).
//
// Residual, stated plainly: 1inch's compact `unoswap` calls name their
// pools, not the output token, so on those the output token isn't
// decoded — the amount, input token, recipient and minimum still are.

import {decodeFunctionData} from 'viem';

export const ONEINCH_ROUTER_V6 = '0x111111125421ca6dc452d289314280a0f8842a65';
/** 0x AllowanceHolder: Cancun chains, and Shanghai chains (0x-settler README). */
export const ZEROX_ALLOWANCE_HOLDERS = ['0x0000000000001ff3684f28c67538d4d072c22734', '0x0000000000005e88410ccdfade4a5efae4b49562'];
/** 0x Settler deployer/registry, the same address on every chain (0x-settler README). */
export const ZEROX_SETTLER_REGISTRY = '0x00000000000004533Fe15556B1E086BB1A72cEae';
/** Taker-submitted Settler feature id in that registry. */
export const ZEROX_TAKER_SUBMITTED_FEATURE = 2n;
/** The backend asks both providers for 1% slippage; this leaves 1% more for rounding and fee accounting. */
export const MAX_FALLBACK_SLIPPAGE_BPS = 200n;

const NATIVE_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS_SPACE = 2n ** 160n;

const ONEINCH_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {name: 'executor', type: 'address'},
      {
        name: 'desc',
        type: 'tuple',
        components: [
          {name: 'srcToken', type: 'address'},
          {name: 'dstToken', type: 'address'},
          {name: 'srcReceiver', type: 'address'},
          {name: 'dstReceiver', type: 'address'},
          {name: 'amount', type: 'uint256'},
          {name: 'minReturnAmount', type: 'uint256'},
          {name: 'flags', type: 'uint256'},
        ],
      },
      {name: 'data', type: 'bytes'},
    ],
    outputs: [],
  },
  ...(['unoswap', 'unoswap2', 'unoswap3'] as const).map((name, i) => ({
    type: 'function' as const,
    name,
    stateMutability: 'nonpayable' as const,
    inputs: [{name: 'token', type: 'uint256'}, {name: 'amount', type: 'uint256'}, {name: 'minReturn', type: 'uint256'}, ...Array.from({length: i + 1}, (_, j) => ({name: `dex${j}`, type: 'uint256'}))],
    outputs: [],
  })),
  ...(['unoswapTo', 'unoswapTo2', 'unoswapTo3'] as const).map((name, i) => ({
    type: 'function' as const,
    name,
    stateMutability: 'nonpayable' as const,
    inputs: [
      {name: 'to', type: 'uint256'},
      {name: 'token', type: 'uint256'},
      {name: 'amount', type: 'uint256'},
      {name: 'minReturn', type: 'uint256'},
      ...Array.from({length: i + 1}, (_, j) => ({name: `dex${j}`, type: 'uint256'})),
    ],
    outputs: [],
  })),
] as const;

const ALLOWANCE_HOLDER_ABI = [
  {
    type: 'function',
    name: 'exec',
    stateMutability: 'payable',
    inputs: [
      {name: 'operator', type: 'address'},
      {name: 'token', type: 'address'},
      {name: 'amount', type: 'uint256'},
      {name: 'target', type: 'address'},
      {name: 'data', type: 'bytes'},
    ],
    outputs: [],
  },
] as const;

const SETTLER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'slippage',
        type: 'tuple',
        components: [
          {name: 'recipient', type: 'address'},
          {name: 'buyToken', type: 'address'},
          {name: 'minAmountOut', type: 'uint256'},
        ],
      },
      {name: 'actions', type: 'bytes[]'},
      {name: 'zid', type: 'bytes32'},
    ],
    outputs: [],
  },
] as const;

export class FallbackTxRejected extends Error {
  constructor(message: string) {
    super(`${message} Refusing to sign.`);
    this.name = 'FallbackTxRejected';
  }
}

function fail(message: string): never {
  throw new FallbackTxRejected(message);
}

function norm(address: unknown): string {
  return typeof address === 'string' ? address.toLowerCase() : '';
}

/** Providers name the chain's own coin 0xEeee…; this app names it the zero address. */
function tokenId(address: string): string {
  const a = norm(address);
  return a === ZERO ? NATIVE_PSEUDO : a;
}

function asAddress(word: bigint): string {
  return `0x${(word % ADDRESS_SPACE).toString(16).padStart(40, '0')}`;
}

export type FallbackTxCheck = {
  provider: '1inch' | '0x';
  quote: {to: string; data: string; value?: string | null; allowanceTarget?: string | null; buyAmount: string};
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  taker: string;
};

/**
 * Throws FallbackTxRejected unless the quote's transaction is exactly the
 * requested swap. For 0x, returns the Settler address the caller must
 * still confirm against 0x's registry (assertZeroExSettlerRegistered).
 */
export function assertFallbackTxMatchesIntent({provider, quote, sellToken, buyToken, sellAmount, taker}: FallbackTxCheck): {settler: string | null} {
  const sell = tokenId(sellToken);
  const buy = tokenId(buyToken);
  const me = norm(taker);
  const nativeSell = sell === NATIVE_PSEUDO;
  const to = norm(quote.to);
  if (!/^0x[0-9a-f]{40}$/.test(to)) fail('The fallback quote has no valid destination.');
  if (typeof quote.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(quote.data)) fail('The fallback quote has unreadable calldata.');
  if (!/^\d+$/.test(String(quote.buyAmount ?? ''))) fail('The fallback quote has no expected output.');
  const buyAmount = BigInt(quote.buyAmount);
  if (buyAmount <= 0n) fail('The fallback quote has no expected output.');
  const floor = (buyAmount * (10_000n - MAX_FALLBACK_SLIPPAGE_BPS)) / 10_000n;

  const valueStr = quote.value == null || quote.value === '' ? '0' : String(quote.value);
  if (!/^\d+$/.test(valueStr)) fail('The fallback quote has an unreadable value.');
  const value = BigInt(valueStr);
  if (value !== (nativeSell ? sellAmount : 0n)) fail('The fallback quote attaches a different amount of native currency than this trade sells.');

  const spender = quote.allowanceTarget ? norm(quote.allowanceTarget) : null;
  // No spender means no approval is asked for (0x omits it when the wallet
  // already has one); when one is asked for, it must be the contract called.
  if (nativeSell ? spender !== null : spender !== null && spender !== to) fail('The fallback quote asks for an approval to a contract other than the one it calls.');

  const checkMin = (min: bigint) => {
    if (min < floor || min <= 0n) fail("The fallback quote's on-chain minimum is lower than the amount shown allows.");
  };

  if (provider === '1inch') {
    if (to !== ONEINCH_ROUTER_V6) fail("The fallback quote doesn't call 1inch's router.");
    let call;
    try {
      call = decodeFunctionData({abi: ONEINCH_ABI, data: quote.data as `0x${string}`});
    } catch {
      fail("The fallback quote calls a 1inch function this app doesn't sign.");
    }
    if (call.functionName === 'swap') {
      const [, desc] = call.args as unknown as [string, {srcToken: string; dstToken: string; dstReceiver: string; amount: bigint; minReturnAmount: bigint}];
      if (norm(desc.srcToken) !== sell || norm(desc.dstToken) !== buy) fail('The fallback quote swaps different tokens than this trade.');
      if (desc.amount !== sellAmount) fail('The fallback quote spends a different amount than you entered.');
      const receiver = norm(desc.dstReceiver);
      if (receiver !== me && receiver !== ZERO) fail('The fallback quote sends the output to someone else.');
      checkMin(desc.minReturnAmount);
      return {settler: null};
    }
    if (nativeSell) fail("The fallback quote calls a 1inch function this app doesn't sign.");
    const args = call.args as unknown as bigint[];
    const hasTo = call.functionName.startsWith('unoswapTo');
    const [token, amount, minReturn] = hasTo ? args.slice(1, 4) : args.slice(0, 3);
    if (hasTo && asAddress(args[0]) !== me) fail('The fallback quote sends the output to someone else.');
    if (asAddress(token) !== sell) fail('The fallback quote spends a different token than this trade.');
    if (amount !== sellAmount) fail('The fallback quote spends a different amount than you entered.');
    checkMin(minReturn);
    return {settler: null};
  }

  // 0x (AllowanceHolder flow)
  if (!ZEROX_ALLOWANCE_HOLDERS.includes(to)) fail("The fallback quote doesn't call 0x's AllowanceHolder.");
  if (nativeSell) fail("0x native-currency sales aren't signed by this app.");
  let exec;
  try {
    exec = decodeFunctionData({abi: ALLOWANCE_HOLDER_ABI, data: quote.data as `0x${string}`});
  } catch {
    fail("The fallback quote calls a 0x function this app doesn't sign.");
  }
  const [operator, token, amount, target, inner] = exec.args as unknown as [string, string, bigint, string, `0x${string}`];
  if (norm(operator) !== norm(target)) fail('The fallback quote lets a different contract take your tokens than the one it runs.');
  if (norm(token) !== sell) fail('The fallback quote spends a different token than this trade.');
  if (amount !== sellAmount) fail('The fallback quote spends a different amount than you entered.');
  let settle;
  try {
    settle = decodeFunctionData({abi: SETTLER_ABI, data: inner});
  } catch {
    fail("The fallback quote runs a 0x Settler function this app doesn't sign.");
  }
  const [slippage] = settle.args as unknown as [{recipient: string; buyToken: string; minAmountOut: bigint}];
  if (norm(slippage.recipient) !== me) fail('The fallback quote sends the output to someone else.');
  if (norm(slippage.buyToken) !== buy) fail('The fallback quote buys a different token than this trade.');
  checkMin(slippage.minAmountOut);
  return {settler: norm(target)};
}

export const ZEROX_REGISTRY_ABI = [
  {type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{name: 'tokenId', type: 'uint256'}], outputs: [{type: 'address'}]},
  {type: 'function', name: 'prev', stateMutability: 'view', inputs: [{name: 'featureId', type: 'uint128'}], outputs: [{type: 'address'}]},
] as const;

type ReadContract = (args: {address: `0x${string}`; abi: typeof ZEROX_REGISTRY_ABI; functionName: 'ownerOf' | 'prev'; args: [bigint]}) => Promise<unknown>;

/**
 * 0x's own rule (0x-settler README): the Settler must be the registry's
 * current one for the feature, or — while 0x's API is still moving to a
 * new deployment — its previous one. A reverting ownerOf means Settler
 * is paused: refuse.
 */
export async function assertZeroExSettlerRegistered(settler: string, readContract: ReadContract): Promise<void> {
  let current: unknown;
  try {
    current = await readContract({address: ZEROX_SETTLER_REGISTRY as `0x${string}`, abi: ZEROX_REGISTRY_ABI, functionName: 'ownerOf', args: [ZEROX_TAKER_SUBMITTED_FEATURE]});
  } catch {
    fail("0x's registry doesn't list an active Settler right now.");
  }
  if (norm(current) === norm(settler)) return;
  const previous = await readContract({address: ZEROX_SETTLER_REGISTRY as `0x${string}`, abi: ZEROX_REGISTRY_ABI, functionName: 'prev', args: [ZEROX_TAKER_SUBMITTED_FEATURE]}).catch(() => null);
  if (norm(previous) === norm(settler)) return;
  fail("The fallback quote routes through a contract 0x's own registry doesn't list.");
}
