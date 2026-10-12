// src/core/intearRouter.ts
//
// A TypeScript port of the site's src/intearRouter.js (mango-bridge.jsx),
// line for line, so Mango Pro and the site enforce exactly the same route
// checks. Keep the two in step: a check added to one belongs in the other.
//
// Best price across every NEAR DEX, through Intear's open-source DEX
// aggregator (github.com/INTEARnear/dex-aggregator, the code behind
// router.intear.tech). One /route call quotes Rhea (classic + DCL
// concentrated pools), Intear's own DEX (Plach), Aidols launchpad
// tokens, and the liquid-staking venues (MetaPool stNEAR, LiNEAR, rNEAR,
// xRHEA) in parallel and returns each venue's route, best first, with
// the exact transactions to sign.
//
// Because the transactions come from a third-party API, none of them is
// signed until assertIntearRouteSafe() has checked it against what the
// aggregator's own source code can ever produce for a plain token-in /
// token-out request (src/providers/*.rs, src/shared_utils.rs):
//   - receivers: only those venues' contracts, wrap.near, or the two
//     tokens being swapped (plus *.aidols.near tokens on Aidols routes),
//     and each method only on the contract that owns it;
//   - methods: only the ones those venues use — no ft_transfer to a
//     stranger, no plain Transfer, no key / account / contract actions;
//   - ft_transfer_call only on the input token, only to a known venue,
//     and together with unstake / liquid_unstake never moving more of
//     the input token than the user entered;
//   - the swap instructions inside each call (the venue's msg /
//     operations) are read field by field: any field a venue could use to
//     send the output elsewhere (a recipient, Intear DEX's TransferAsset
//     or Withdraw-to-someone-else, Rhea's client_echo) is refused, and
//     the minimums the venue will enforce on-chain must add up to at
//     least the "minimum received" shown to the user;
//   - attached NEAR never exceeds the NEAR being swapped plus a small
//     storage allowance; storage_deposit only ever registers the user.
// A route that fails any of this is skipped.
//
// Differences from the site, both forced by Mango's gas relayer (it only
// sponsors contract calls, near-relayer.js): feeTransaction() has no
// native-NEAR branch (a plain Transfer can't be relayed) and names the
// fee token `token` rather than `tokenIn` (a Sell's fee is paid from the
// USDC it received), and call
// arguments are decoded with Buffer (the app's polyfill) instead of
// atob/TextDecoder.

import {NATIVE_NEAR, WRAP_NEAR} from './chainData.ts';
import type {NearCall, NearFunctionCall} from './nearSigning.ts';

export const INTEAR_ROUTE_URL = 'https://router.intear.tech/route';

export const DEX_LABEL: Record<string, string> = {
  Rhea: 'Rhea',
  RheaDcl: 'Rhea DCL',
  Plach: 'Intear DEX',
  Aidols: 'Aidols',
  MetaPool: 'Meta Pool',
  Linear: 'LiNEAR',
  RNear: 'rNEAR',
  XRhea: 'xRHEA',
  Wrap: 'Wrap',
};

const RHEA = 'v2.ref-finance.near';
const RHEA_DCL = 'dclv2.ref-labs.near';
const INTEAR_DEX = 'dex.intear.near';
const AIDOLS = 'aidols.near';
const METAPOOL = 'meta-pool.near';
const LINEAR = 'linear-protocol.near';
const XRHEA = 'xtoken.rhealab.near';
const RNEAR = 'lst.rhealab.near';

// Every contract the aggregator's providers send transactions to or
// transfer tokens into (src/providers/*.rs).
export const VENUE_CONTRACTS = new Set([RHEA, RHEA_DCL, INTEAR_DEX, AIDOLS, METAPOOL, LINEAR, XRHEA, RNEAR, WRAP_NEAR]);

// Method → the only contracts it may be called on. ft_transfer_call and
// storage_deposit are checked separately (they live on token contracts).
// Not here on purpose: Rhea's `swap` / `withdraw` and Intear DEX's
// `execute_operations` / `withdraw` — the aggregator only emits those for
// balances already held inside a DEX, which this app never asks for, and
// they could spend such balances.
const METHOD_RECEIVERS: Record<string, string[]> = {
  near_deposit: [WRAP_NEAR],
  near_withdraw: [WRAP_NEAR],
  deposit_and_stake: [METAPOOL, LINEAR, RNEAR],
  deposit_near: [INTEAR_DEX],
  register_assets: [INTEAR_DEX],
  register_tokens: [RHEA_DCL],
  liquid_unstake: [METAPOOL],
  unstake: [XRHEA],
};

// Storage registrations across a route (output token, DEX accounts) —
// far above what they really cost, far below anything worth stealing.
export const MAX_STORAGE_NEAR = 500000000000000000000000n; // 0.5 NEAR

export class IntearRouteError extends Error {}

type Json = Record<string, any>;

/** The aggregator's route shape (src/types.rs), as much of it as this file reads. */
export type IntearRoute = {
  dex_id?: string;
  token_output?: string;
  estimated_amount?: {amount_out?: string | number; amount_in?: string | number};
  worst_case_amount?: {amount_out?: string | number; amount_in?: string | number};
  execution_instructions?: unknown[];
  deadline?: string | null;
};

export type SafeRoute = {dexId: string | undefined; label: string | undefined; amountOut: bigint; minOut: bigint; txs: NearCall[]; deadline: string | null};

type SwapCheck = {accountId: string; tokenIn: string; tokenOut: string; amountIn: bigint; minOut?: bigint | null};
type Ctx = {accountId: string; tokenOut: string; routingOut: string; outAssets: string[]};

function fail(message: string): never {
  throw new IntearRouteError(message);
}

export function intearTokenParam(tokenId: string): string {
  return tokenId === NATIVE_NEAR ? 'near' : `nep141:${tokenId}`;
}

function amountOf(tagged: IntearRoute['estimated_amount']): bigint | null {
  const v = tagged?.amount_out ?? tagged?.amount_in;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

function decodeArgs(args: unknown): Json {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Json;
  if (typeof args !== 'string') fail('Unreadable call arguments.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args) || args.length % 4 !== 0) fail('Unreadable call arguments.');
  let text: string;
  try {
    text = Buffer.from(args, 'base64').toString('utf8');
  } catch {
    fail('Unreadable call arguments.');
  }
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Unexpected call arguments.');
    return parsed;
  } catch (e) {
    if (e instanceof IntearRouteError) throw e;
    fail('Non-JSON call arguments.');
  }
}

function toBig(value: unknown, what: string): bigint {
  const s = String(value ?? '0');
  if (!/^\d+$/.test(s)) fail(`Bad ${what}.`);
  return BigInt(s);
}

/** Intear's NearTransaction instructions → Mango's NearCall list. Throws on anything but FunctionCall. */
export function toWalletTransactions(route: IntearRoute): NearCall[] {
  const list = Array.isArray(route?.execution_instructions) ? route.execution_instructions : [];
  if (list.length === 0) fail('The route has no transactions.');
  return list.map(instr => {
    const tx = (instr as Json)?.NearTransaction;
    if (!tx || typeof tx.receiver_id !== 'string' || !Array.isArray(tx.actions) || tx.actions.length === 0) fail('Unknown instruction in route.');
    return {
      receiverId: tx.receiver_id,
      actions: tx.actions.map((a: Json): NearFunctionCall => {
        const fc = a?.FunctionCall;
        if (!fc || Object.keys(a).length !== 1) fail('The route contains a non-call action.');
        return {
          type: 'FunctionCall',
          params: {
            methodName: String(fc.method_name),
            args: decodeArgs(fc.args),
            gas: toBig(fc.gas, 'gas').toString(),
            deposit: toBig(fc.deposit, 'deposit').toString(),
          },
        };
      }),
    };
  });
}

function isAidolsToken(id: unknown): boolean {
  return typeof id === 'string' && id.endsWith('.aidols.near');
}

function onlyKeys(obj: unknown, allowed: string[], what: string): Json {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`Unreadable ${what}.`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`The route's ${what} has an unexpected field (${k}).`);
  return obj as Json;
}

function parseMsg(msg: unknown, what: string): unknown {
  if (typeof msg !== 'string') fail(`Unreadable ${what}.`);
  try {
    return JSON.parse(msg);
  } catch {
    fail(`Unreadable ${what}.`);
  }
}

function isSelfOrUnset(value: unknown, accountId: string): boolean {
  return value === undefined || value === null || value === accountId;
}

// Intear DEX (Plach) operations — serde's externally tagged enum from
// src/providers/intear_plach.rs. Only swaps, withdrawals back to the
// user, and asset registration; returns the output minimum it enforces.
function inspectIntearOperations(operations: unknown, {accountId, outAssets}: {accountId: string; outAssets: string[]}): bigint {
  if (!Array.isArray(operations) || operations.length === 0) fail('Unreadable Intear DEX operations.');
  let min = 0n;
  for (const op of operations) {
    const kind = op && typeof op === 'object' ? Object.keys(op) : [];
    if (kind.length !== 1) fail('Unreadable Intear DEX operation.');
    const body = op[kind[0]];
    if (kind[0] === 'SwapSimple') {
      onlyKeys(body, ['dex_id', 'message', 'asset_in', 'asset_out', 'amount', 'constraint'], 'Intear DEX swap');
      const a = body.amount;
      const exactIn = a && typeof a === 'object' && a.Amount && typeof a.Amount === 'object' && Object.keys(a.Amount).length === 1 && 'ExactIn' in a.Amount;
      if (a !== 'OutputOfLastIn' && !exactIn) fail("The route swaps an amount it shouldn't.");
    } else if (kind[0] === 'Withdraw') {
      onlyKeys(body, ['asset_id', 'amount', 'to', 'rescue_address'], 'Intear DEX withdrawal');
      if (!isSelfOrUnset(body.to, accountId) || !isSelfOrUnset(body.rescue_address, accountId)) fail('The route withdraws to someone else.');
      if (outAssets.includes(body.asset_id)) {
        const amt = body.amount;
        if (amt && typeof amt === 'object' && amt.Full && typeof amt.Full === 'object') min += amt.Full.at_least == null ? 0n : toBig(amt.Full.at_least, 'minimum');
        else if (amt && typeof amt === 'object' && 'Exact' in amt) min += toBig(amt.Exact, 'minimum');
      }
    } else if (kind[0] === 'RegisterAssets') {
      onlyKeys(body, ['asset_ids', 'for'], 'Intear DEX registration');
      if (body.for !== undefined && body.for !== null) fail('The route registers assets for someone else.');
    } else {
      fail(`The route uses an unexpected Intear DEX operation (${kind[0]}).`);
    }
  }
  return min;
}

/**
 * The swap instructions inside one ft_transfer_call, by venue. Returns
 * the output minimum that venue will enforce (0n for staking venues,
 * which have a fixed rate).
 */
function inspectVenueMsg(venue: string, msg: unknown, {accountId, tokenOut, routingOut, outAssets}: Ctx): {min: bigint; isSwap: boolean} {
  if (venue === RHEA) {
    const m = onlyKeys(parseMsg(msg, 'Rhea swap'), ['force', 'actions', 'skip_degen_price_sync', 'skip_unwrap_near', 'referral_id'], 'Rhea swap');
    if (m.force !== undefined && m.force !== 0) fail('Unexpected Rhea swap mode.');
    if (m.skip_unwrap_near === false && tokenOut !== NATIVE_NEAR) fail('The route unwraps NEAR unexpectedly.');
    if (!Array.isArray(m.actions) || m.actions.length === 0) fail('The Rhea swap has no steps.');
    let min = 0n;
    for (const a of m.actions) {
      onlyKeys(a, ['pool_id', 'token_in', 'token_out', 'amount_in', 'min_amount_out'], 'Rhea swap step');
      if (a.token_out === routingOut) min += toBig(a.min_amount_out, 'minimum');
    }
    return {min, isSwap: true};
  }
  if (venue === RHEA_DCL) {
    const m = onlyKeys(parseMsg(msg, 'Rhea DCL swap'), ['Swap'], 'Rhea DCL swap');
    const s = onlyKeys(m.Swap, ['pool_ids', 'output_token', 'min_output_amount', 'skip_unwrap_near'], 'Rhea DCL swap');
    if (s.skip_unwrap_near === false && tokenOut !== NATIVE_NEAR) fail('The route unwraps NEAR unexpectedly.');
    return {min: s.output_token === routingOut ? toBig(s.min_output_amount, 'minimum') : 0n, isSwap: true};
  }
  if (venue === INTEAR_DEX) {
    const m = onlyKeys(parseMsg(msg, 'Intear DEX swap'), ['operations', 'referrer'], 'Intear DEX swap');
    return {min: inspectIntearOperations(m.operations, {accountId, outAssets}), isSwap: true};
  }
  if (venue === AIDOLS) {
    const m = onlyKeys(parseMsg(msg, 'Aidols swap'), ['token', 'min_swap_amount', 'referral'], 'Aidols swap');
    return {min: toBig(m.min_swap_amount, 'minimum'), isSwap: true};
  }
  if (venue === XRHEA) {
    const m = onlyKeys(parseMsg(msg, 'xRHEA stake'), ['Stake'], 'xRHEA stake');
    onlyKeys(m.Stake, [], 'xRHEA stake');
    return {min: 0n, isSwap: false};
  }
  fail(`The route sends tokens to ${venue} with an unexpected message.`);
}

/**
 * Checks converted transactions against what this swap may do.
 * `tokenIn` / `tokenOut` are NATIVE_NEAR or a NEP-141 contract.
 */
export function assertIntearRouteSafe(txs: NearCall[], {accountId, tokenIn, tokenOut, amountIn, minOut}: SwapCheck): void {
  const routingIn = tokenIn === NATIVE_NEAR ? WRAP_NEAR : tokenIn;
  const routingOut = tokenOut === NATIVE_NEAR ? WRAP_NEAR : tokenOut;
  // How the output token is named inside Intear DEX operations.
  const outAssets = tokenOut === NATIVE_NEAR ? ['near', `nep141:${WRAP_NEAR}`] : [`nep141:${routingOut}`];
  const receivers = new Set([...VENUE_CONTRACTS, routingIn, routingOut]);
  const ctx: Ctx = {accountId, tokenOut, routingOut, outAssets};
  let movedIn = 0n;
  let attachedNear = 0n;
  let onchainMin = 0n;
  let hasSwap = false;

  for (const tx of txs) {
    if (!receivers.has(tx.receiverId) && !isAidolsToken(tx.receiverId)) fail(`The route calls an unexpected contract (${tx.receiverId}).`);
    for (const {type, params} of tx.actions) {
      if (type !== 'FunctionCall') fail('The route contains a non-call action.');
      const method = params.methodName;
      const args: Json = params.args || {};
      attachedNear += BigInt(params.deposit);
      if (method === 'ft_transfer_call') {
        if (tx.receiverId !== routingIn) fail("The route moves a token other than the one you're paying with.");
        onlyKeys(args, ['receiver_id', 'amount', 'msg', 'memo'], 'token transfer');
        if (!VENUE_CONTRACTS.has(args.receiver_id) || args.receiver_id === WRAP_NEAR) fail(`The route sends tokens to an unexpected account (${args.receiver_id}).`);
        movedIn += toBig(args.amount, 'amount');
        const {min, isSwap} = inspectVenueMsg(args.receiver_id, args.msg, ctx);
        onchainMin += min;
        hasSwap = hasSwap || isSwap;
      } else if (method === 'storage_deposit') {
        if (!isSelfOrUnset(args.account_id, accountId)) fail('The route registers storage for someone else.');
      } else if (METHOD_RECEIVERS[method]) {
        if (!METHOD_RECEIVERS[method].includes(tx.receiverId)) fail(`The route calls ${method} on an unexpected contract (${tx.receiverId}).`);
        if (method === 'near_withdraw' && tokenOut !== NATIVE_NEAR) {
          // unwrapping is only ever part of a swap that ends in NEAR
          fail('The route unwraps NEAR unexpectedly.');
        }
        if (method === 'deposit_and_stake') onlyKeys(args, [], 'staking call');
        if (method === 'deposit_near') {
          onlyKeys(args, ['operations'], 'Intear DEX deposit');
          const ops = onlyKeys(args.operations, ['operations', 'referrer'], 'Intear DEX deposit');
          onchainMin += inspectIntearOperations(ops.operations, ctx);
          hasSwap = true;
        }
        if (method === 'liquid_unstake') {
          if (routingIn !== METAPOOL) fail("The route unstakes a token you're not paying with.");
          onlyKeys(args, ['st_near_to_burn', 'min_expected_near'], 'Meta Pool unstake');
          movedIn += toBig(args.st_near_to_burn, 'amount');
          onchainMin += toBig(args.min_expected_near, 'minimum');
          hasSwap = true;
        }
        if (method === 'unstake') {
          if (routingIn !== XRHEA) fail("The route unstakes a token you're not paying with.");
          onlyKeys(args, ['amount', 'msg'], 'xRHEA unstake');
          movedIn += toBig(args.amount, 'amount');
        }
      } else {
        fail(`The route uses an unexpected method (${method}).`);
      }
    }
  }
  if (movedIn > amountIn) fail('The route would spend more than you entered.');
  const nearBudget = (tokenIn === NATIVE_NEAR ? amountIn : 0n) + MAX_STORAGE_NEAR;
  if (attachedNear > nearBudget) fail('The route attaches more NEAR than this swap needs.');
  // What the exchanges will actually enforce must cover what we show.
  if (hasSwap && minOut != null && onchainMin < minOut) fail("The route's on-chain minimum is lower than the minimum shown.");
}

/**
 * Asks the aggregator for routes. Returns the raw list, best first.
 * `accountId` makes the routes include the user's storage deposits.
 */
export async function fetchIntearRoutes({
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
  accountId,
  fetchImpl = fetch,
  timeoutMs = 8000,
}: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
  accountId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<IntearRoute[]> {
  const params = new URLSearchParams({
    token_in: intearTokenParam(tokenIn),
    token_out: intearTokenParam(tokenOut),
    amount_in: amountIn.toString(),
    max_wait_ms: '2500',
    slippage_type: 'Fixed',
    slippage: (Math.max(0, Math.min(5000, slippageBps)) / 10000).toString(),
  });
  if (accountId) params.set('trader_account_id', accountId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${INTEAR_ROUTE_URL}?${params}`, {signal: controller.signal} as RequestInit);
    if (!res.ok) throw new Error(`NEAR aggregator error (${res.status}).`);
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The best route that converts, passes every check, and ends in the
 * requested token (or in wNEAR when NEAR was requested, in which case the
 * guaranteed minimum is unwrapped afterwards). Null if none qualifies.
 */
export function pickSafeRoute(routes: IntearRoute[], {accountId, tokenIn, tokenOut, amountIn}: Omit<SwapCheck, 'minOut'> & {accountId?: string}): SafeRoute | null {
  const wantOut = intearTokenParam(tokenOut);
  for (const route of routes) {
    try {
      const estimated = amountOf(route.estimated_amount);
      const worst = amountOf(route.worst_case_amount);
      if (!estimated || !worst || worst <= 0n || worst > estimated) continue;
      const txs = toWalletTransactions(route);
      const endsIn = route.token_output;
      const unwrapAfter = tokenOut === NATIVE_NEAR && endsIn === `nep141:${WRAP_NEAR}`;
      if (endsIn !== wantOut && !unwrapAfter) continue;
      if (unwrapAfter) {
        txs.push({receiverId: WRAP_NEAR, actions: [{type: 'FunctionCall', params: {methodName: 'near_withdraw', args: {amount: worst.toString()}, gas: '10000000000000', deposit: '1'}}]});
      }
      if (accountId) assertIntearRouteSafe(txs, {accountId, tokenIn, tokenOut, amountIn, minOut: worst});
      return {dexId: route.dex_id, label: route.dex_id ? (DEX_LABEL[route.dex_id] ?? route.dex_id) : undefined, amountOut: estimated, minOut: worst, txs, deadline: route.deadline ?? null};
    } catch {
      // try the next venue
    }
  }
  return null;
}

/**
 * Mango's fee as its own call on a NEP-141 token: [register the fee
 * account if needed] + ft_transfer. Null when there's no fee. Native NEAR
 * isn't supported — a plain Transfer can't go through Mango's relayer.
 */
export function feeTransaction({
  token,
  fee,
  feeAccount,
  feeRegistration,
}: {
  token: string;
  fee: bigint;
  feeAccount: string;
  feeRegistration?: {needed: boolean; deposit: bigint} | null;
}): NearCall | null {
  if (fee <= 0n) return null;
  if (token === NATIVE_NEAR) throw new IntearRouteError("Mango's fee can't be paid in native NEAR.");
  const actions: NearFunctionCall[] = [];
  if (feeRegistration?.needed) {
    actions.push({type: 'FunctionCall', params: {methodName: 'storage_deposit', args: {account_id: feeAccount, registration_only: true}, gas: '10000000000000', deposit: feeRegistration.deposit.toString()}});
  }
  actions.push({type: 'FunctionCall', params: {methodName: 'ft_transfer', args: {receiver_id: feeAccount, amount: fee.toString(), memo: 'Mango swap fee'}, gas: '10000000000000', deposit: '1'}});
  return {receiverId: token, actions};
}
