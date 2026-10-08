// src/core/nearTrade.ts
//
// Trading NEAR tokens with the wallet's USDC on NEAR — Mango Pro's
// USDC-first model on NEAR: Buy spends USDC on NEAR for a token, Sell
// turns a token back into USDC on NEAR. Built from pieces that already
// exist and are tested:
//   - routes: Intear's aggregator over every NEAR DEX, and the site's own
//     route checks (intearRouter.ts, ported line for line);
//   - sending: the wallet's own NEAR key, gas paid by Mango's relayer
//     (nearSigning.ts);
//   - what happened: the user's own call results from the relayer, read
//     the site's way (nearOutcome.ts) — a refunded swap is never "Bought".
//
// Mango's fee (0.5%, DEV_FEE_WALLET_NEAR) is always taken in USDC and sent
// as its own call only AFTER the swap is confirmed: a Buy pays it from the
// USDC it set aside, a Sell from the USDC it just received. A cancelled
// swap pays no fee; a partly filled one pays the same share. NEAR gas is
// covered by Mango (it costs a fraction of a cent per swap).

import {NATIVE_NEAR, NEAR_USDC, NEAR_USDC_DECIMALS, WRAP_NEAR, TOKEN_ADDRESSES, assetDecimalsForChain, type ChainKey} from './chainData.ts';
import {DEV_FEE_WALLET_NEAR, appFeeBps} from './fees.ts';
import {IntearRouteError, assertIntearRouteSafe, feeTransaction, fetchIntearRoutes, pickSafeRoute, type IntearRoute, type SafeRoute} from './intearRouter.ts';
import {classifySwapOutcomes, type SwapOutcomeStatus} from './nearOutcome.ts';
import {nearRpc, nearView} from './nearRpc.ts';
import {assertRelayGaslessEvmAvailable} from './relayGaslessEvm.ts';
import {getViemChain} from './chainRegistry.ts';
import {NearSendError, ensureNearAccount, sendSponsoredNearCalls, type NearCall, type NearRelayOutcome} from './nearSigning.ts';
import type {DerivedAccounts} from '../wallet/keys';
import {fetchUsdcPortfolio} from './usdcBalances.ts';
import {fetchOneClickTokens, findOneClickAssetId, ONE_CLICK_PROXY_BASE_URL, type OneClickQuoteRequest, requestOneClickQuote, fetchOneClickStatus, submitOneClickDepositTx} from './oneClick.ts';
import {fundOneClickQuote, type OneClickSwapStore} from './oneClickDeposits.ts';

export type NearTradeSide = 'buy' | 'sell';

/** Used when the user left slippage on Auto: 1%, the site's NEAR swap default. */
export const NEAR_TRADE_DEFAULT_SLIPPAGE_BPS = 100;
/** A quote older than this is re-fetched (and re-checked) before sending. */
export const NEAR_QUOTE_MAX_AGE_MS = 20_000;
/** Mango's relayer refuses a delegate above this (near-relayer.js MAX_DELEGATE_GAS). */
export const RELAY_MAX_GAS = 300_000_000_000_000n;

/**
 * Moves only the missing USDC to the user's NEAR account before a NEAR Buy.
 * NEAR is not a Relay chain, so this uses the app's already-integrated
 * NEAR Intents 1Click path for the cross-chain cash leg, then the existing
 * Intear/Rhea path for the actual token trade. The funding leg deliberately
 * has a 0 Mango app fee; the trade itself charges the normal Mango fee once.
 */
export async function fundNearUsdcForTrade(
  session: DerivedAccounts,
  neededUnits: bigint,
  {store, now = () => Date.now()}: {
    store: OneClickSwapStore;
    now?: () => number;
  },
): Promise<{sourceChain: ChainKey; sourceAmount: string; depositAddress: string; destinationTxHashes: string[]}> {
  if (!session.near) throw new NearTradeError('This wallet has no NEAR account.');
  if (neededUnits <= 0n) return {sourceChain: 'ethereum', sourceAmount: '0', depositAddress: '', destinationTxHashes: []};

  const portfolio = await fetchUsdcPortfolio(session, {forceFresh: true});
  const candidates = portfolio.results
    .filter((r): r is Extract<typeof r, {status: 'ok'}> => r.status === 'ok' && r.balance > 0 && Boolean(TOKEN_ADDRESSES.USDC[r.chainKey]) && r.chainKey !== 'arc')
    .sort((a, b) => b.balance - a.balance);
  if (candidates.length === 0) throw new NearTradeError('There is no USDC available on a supported source chain to fund this NEAR trade.');

  const tokens = await fetchOneClickTokens({baseUrl: ONE_CLICK_PROXY_BASE_URL, timeoutMs: 20_000});
  const destinationAsset = findOneClickAssetId(tokens, 'near', NEAR_USDC);
  if (!destinationAsset) throw new NearTradeError('NEAR USDC is not currently available through NEAR Intents.');

  const factors = [102, 105, 110, 125];
  const nowMs = now();
  const deadline = new Date(nowMs + 20 * 60 * 1000).toISOString();

  for (const source of candidates) {
    const sourceChain = source.chainKey;
    const blockchain = ({ethereum: 'eth', base: 'base', arbitrum: 'arb', bnb: 'bsc', avalanche: 'avax', solana: 'sol', plasma: 'plasma', xlayer: 'xlayer'} as Partial<Record<ChainKey, string>>)[sourceChain];
    const sourceContract = TOKEN_ADDRESSES.USDC[sourceChain];
    if (!blockchain || !sourceContract) continue;

    // NEAR Intents still requires the origin-chain USDC deposit transaction.
    // For Mango's local-seed EVM wallets, that source transaction is itself
    // gasless through the same Relay/Calibur executor used by the rest of
    // Mango's EVM cash movement. Refuse a source candidate that Relay cannot
    // actually sponsor instead of showing a quote that will later die on gas.
    // Google/Particle sessions keep their existing Particle signing path.
    if (sourceChain !== 'solana' && session.authMethod !== 'google') {
      try {
        await assertRelayGaslessEvmAvailable(getViemChain(sourceChain));
      } catch {
        continue;
      }
    }
    const sourceAsset = findOneClickAssetId(tokens, blockchain, sourceContract);
    if (!sourceAsset) continue;
    const decimals = assetDecimalsForChain(sourceChain, 'USDC') ?? NEAR_USDC_DECIMALS;
    const availableUnits = BigInt(Math.floor(source.balance * 10 ** decimals));
    if (availableUnits <= 0n) continue;

    for (const factor of factors) {
      const desired = (neededUnits * BigInt(factor) + 99n) / 100n;
      const amount = desired < availableUnits ? desired : availableUnits;
      if (amount < neededUnits) continue;
      const request: OneClickQuoteRequest = {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: sourceAsset,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset,
        amount: amount.toString(),
        refundTo: sourceChain === 'solana' ? session.solana.address : session.evm.address,
        refundType: 'ORIGIN_CHAIN',
        recipient: session.near.address,
        recipientType: 'DESTINATION_CHAIN',
        deadline,
        depositMode: 'SIMPLE',
        appFees: [{recipient: 'widekingdom6862.near', fee: 0}],
      };
      let quoteResponse;
      try {
        quoteResponse = await requestOneClickQuote(request, {baseUrl: ONE_CLICK_PROXY_BASE_URL, timeoutMs: 20_000});
      } catch {
        continue;
      }
      const minOut = BigInt(quoteResponse.quote?.minAmountOut || '0');
      if (minOut < neededUnits) continue;

      const record = await fundOneClickQuote({
        response: quoteResponse,
        expected: {
          originAsset: sourceAsset,
          destinationAsset,
          amount: quoteResponse.quote.amountIn,
          recipient: session.near.address,
          recipientType: 'DESTINATION_CHAIN',
          refundTo: sourceChain === 'solana' ? session.solana.address : session.evm.address,
          maxSlippageBps: 100,
          appFees: [],
        },
        originChainKey: sourceChain,
        originSymbol: 'USDC',
        originDecimals: decimals,
        fromAddress: sourceChain === 'solana' ? session.solana.address : session.evm.address,
        send: async (to, sendAmount) => {
          const {sendUsdc} = await import('../wallet/sendUsdc.ts');
          return (await sendUsdc(sourceChain, session, to, sendAmount, 'USDC', true)).txId;
        },
        store,
        submitDepositTx: (txHash, depositAddress) => submitOneClickDepositTx(txHash, depositAddress, {baseUrl: ONE_CLICK_PROXY_BASE_URL}),
        now,
      });

      const pollDeadline = now() + 4 * 60 * 1000;
      let status = record.status;
      let destinationTxHashes: string[] = [];
      while (now() < pollDeadline) {
        const current = await fetchOneClickStatus(record.depositAddress, {baseUrl: ONE_CLICK_PROXY_BASE_URL, timeoutMs: 20_000});
        status = current.status;
        destinationTxHashes = current.swapDetails?.destinationChainTxHashes?.map(t => t.hash) ?? destinationTxHashes;
        if (status === 'SUCCESS') return {sourceChain, sourceAmount: record.payAmount, depositAddress: record.depositAddress, destinationTxHashes};
        if (status === 'FAILED' || status === 'REFUNDED') {
          throw new NearTradeError(current.swapDetails?.refundReason || 'NEAR Intents could not deliver USDC to your NEAR account.');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new NearTradeError('USDC is still moving to NEAR. Wait a moment and try the trade again — the transfer is being tracked in History.');
    }
  }
  throw new NearTradeError('No supported USDC source could currently fund the NEAR trade.');
}
/** NEAR's storage price: 10^19 yoctoNEAR per byte. */
const YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
/** NEP-145 minimum when a token contract doesn't answer storage_balance_bounds (0.00125 NEAR). */
const DEFAULT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

export class NearTradeError extends Error {}

type View = <T = any>(contractId: string, method: string, args?: unknown) => Promise<T>;
type Rpc = typeof nearRpc;
type Send = typeof sendSponsoredNearCalls;

export type NearTokenMeta = {decimals: number; symbol: string};

/** A NEP-141 token's decimals and symbol (ft_metadata). */
export async function fetchNearTokenMeta(tokenId: string, view: View = nearView): Promise<NearTokenMeta> {
  const meta = await view<{decimals?: unknown; symbol?: unknown}>(tokenId, 'ft_metadata', {});
  const decimals = Number(meta?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new NearTradeError("Couldn't verify this token.");
  return {decimals, symbol: typeof meta?.symbol === 'string' ? meta.symbol : ''};
}

/** The wallet's balance of a NEP-141 token, in base units (0 when unregistered). */
export async function fetchNearTokenBalance(tokenId: string, accountId: string, view: View = nearView): Promise<bigint> {
  const raw = await view<string | null>(tokenId, 'ft_balance_of', {account_id: accountId});
  return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

/** Mango's fee on `usdcUnits` of USDC — 0.5%, capped at $50 (fees.ts appFeeBps). */
export function nearTradeFee(usdcUnits: bigint): bigint {
  if (usdcUnits <= 0n) return 0n;
  const usd = Number(usdcUnits) / 10 ** NEAR_USDC_DECIMALS;
  return (usdcUnits * BigInt(appFeeBps(usd))) / 10_000n;
}

export type NearTradeStage = {
  tokenIn: string;
  tokenOut: string;
  route: SafeRoute;
};

export type NearTradeQuote = {
  side: NearTradeSide;
  token: string;
  /** What the user typed, in the pay token's base units. */
  payUnits: bigint;
  /** What goes into the swap: payUnits minus the fee on a Buy, payUnits on a Sell. */
  swapIn: bigint;
  tokenIn: string;
  tokenOut: string;
  route: SafeRoute;
  /** Optional two-stage route, used when USDC and a Nearly DCL launch require wNEAR as the intermediate asset. */
  stages?: NearTradeStage[];
  /** Mango's fee in USDC base units, before any partial-fill adjustment. */
  fee: bigint;
  /** What the user can expect / is guaranteed, after the fee. */
  receiveUnits: bigint;
  minReceiveUnits: bigint;
  slippageBps: number;
  quotedAt: number;
};

function totalGas(call: NearCall): bigint {
  return call.actions.reduce((sum, a) => sum + BigInt(a.params.gas), 0n);
}

/** The best route that passes every check AND fits Mango's relayer (per-call gas, no native NEAR spent). */
export function pickRelayableRoute(routes: IntearRoute[], check: {accountId: string; tokenIn: string; tokenOut: string; amountIn: bigint}): SafeRoute | null {
  for (const route of routes) {
    const picked = pickSafeRoute([route], check);
    if (picked && picked.txs.every(tx => totalGas(tx) <= RELAY_MAX_GAS)) return picked;
  }
  return null;
}

/**
 * A live quote: Buy spends `payUnits` of USDC on NEAR on `token`, Sell
 * spends `payUnits` of `token` for USDC on NEAR.
 */
export async function quoteNearTrade({
  side,
  token,
  payUnits,
  accountId,
  slippageBps,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  side: NearTradeSide;
  token: string;
  payUnits: bigint;
  accountId: string;
  slippageBps?: number | null;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<NearTradeQuote> {
  if (!token || token === NATIVE_NEAR || token === NEAR_USDC) throw new NearTradeError("This token can't be traded here.");
  if (payUnits <= 0n) throw new NearTradeError('Enter an amount.');
  const bps = slippageBps != null && Number.isFinite(slippageBps) && slippageBps > 0 ? Math.round(slippageBps) : NEAR_TRADE_DEFAULT_SLIPPAGE_BPS;
  const buy = side === 'buy';
  const tokenIn = buy ? NEAR_USDC : token;
  const tokenOut = buy ? token : NEAR_USDC;
  const buyFee = buy ? nearTradeFee(payUnits) : 0n;
  const swapIn = payUnits - buyFee;
  if (swapIn <= 0n) throw new NearTradeError('This amount is too small to trade.');
  const routes = await fetchIntearRoutes({tokenIn, tokenOut, amountIn: swapIn, slippageBps: bps, accountId, fetchImpl});
  let route = pickRelayableRoute(routes, {accountId, tokenIn, tokenOut, amountIn: swapIn});
  let stages: NearTradeStage[] | undefined;

  // Intear providers are individually routed: Rhea can find USDC -> wNEAR,
  // while Rhea DCL can find wNEAR -> a Nearly launch token, but the aggregator
  // does not compose a Rhea hop with a DCL hop into one quote. Nearly launch
  // pools such as NEARLY/wNEAR therefore need a safe two-stage route.
  //
  // This is deliberately limited to actual Nearly token accounts. We do not
  // guess that an arbitrary ".near" token is a DCL launch, and every stage
  // still goes through the exact same route firewall + relayer gas checks.
  if (!route && token.endsWith('.nearlytrade.near') && token !== NEAR_USDC) {
    const intermediate = WRAP_NEAR;
    const firstRoutes = await fetchIntearRoutes({
      tokenIn,
      tokenOut: intermediate,
      amountIn: swapIn,
      slippageBps: bps,
      accountId,
      fetchImpl,
    });
    const first = pickRelayableRoute(firstRoutes, {
      accountId,
      tokenIn,
      tokenOut: intermediate,
      amountIn: swapIn,
    });
    if (first) {
      const secondRoutes = await fetchIntearRoutes({
        tokenIn: intermediate,
        tokenOut,
        // Spend only the first stage's guaranteed minimum. Any better fill
        // stays in the wallet instead of being silently spent.
        amountIn: first.minOut,
        slippageBps: bps,
        accountId,
        fetchImpl,
      });
      const second = pickRelayableRoute(secondRoutes, {
        accountId,
        tokenIn: intermediate,
        tokenOut,
        amountIn: first.minOut,
      });
      if (second) {
        route = second;
        stages = [
          {tokenIn, tokenOut: intermediate, route: first},
          {tokenIn: intermediate, tokenOut, route: second},
        ];
      }
    }
  }

  if (!route) throw new NearTradeError(routes.length ? 'No safe route for this trade right now.' : 'No NEAR exchange can fill this trade right now.');
  const fee = buy ? buyFee : nearTradeFee(route.minOut);
  return {
    side,
    token,
    payUnits,
    swapIn,
    tokenIn,
    tokenOut,
    route,
    stages,
    fee,
    receiveUnits: buy ? route.amountOut : route.amountOut - fee,
    minReceiveUnits: buy ? route.minOut : route.minOut - fee,
    slippageBps: bps,
    quotedAt: now,
  };
}

/** [register `accountId` on `tokenId`] when it isn't yet — null when it already is. */
async function storageRegistration(tokenId: string, accountId: string, view: View): Promise<{needed: boolean; deposit: bigint}> {
  const registered = await view(tokenId, 'storage_balance_of', {account_id: accountId});
  if (registered) return {needed: false, deposit: 0n};
  let deposit = DEFAULT_STORAGE_DEPOSIT;
  try {
    const bounds = await view<{min?: string}>(tokenId, 'storage_balance_bounds', {});
    if (bounds?.min && /^\d+$/.test(bounds.min)) deposit = BigInt(bounds.min);
  } catch {
    // keep the usual minimum
  }
  return {needed: true, deposit};
}

/** NEAR the account can spend: its balance minus what its stored data locks. */
async function spendableNear(accountId: string, rpc: Rpc): Promise<bigint> {
  try {
    const acct = await rpc<{amount: string; storage_usage: number | string}>('query', {request_type: 'view_account', finality: 'final', account_id: accountId});
    const locked = BigInt(acct.storage_usage) * YOCTO_PER_BYTE;
    const amount = BigInt(acct.amount);
    return amount > locked ? amount - locked : 0n;
  } catch {
    return 0n;
  }
}

function attachedNear(calls: NearCall[]): bigint {
  return calls.reduce((sum, c) => sum + c.actions.reduce((s, a) => s + BigInt(a.params.deposit), 0n), 0n);
}

export type NearTradeResult = {
  status: SwapOutcomeStatus;
  /** Swap hashes, then the fee's when one was sent. */
  hashes: string[];
  feeCharged: bigint;
  /** Set when the swap went through but Mango's fee couldn't be sent (the trade itself is unaffected). */
  feeError: string | null;
};

/** Fee owed after the swap: none when refunded, the filled share when partial. */
export function feeAfterSwap(quote: NearTradeQuote, status: SwapOutcomeStatus, usedIn: bigint | null): bigint {
  if (status === 'ok') return quote.fee;
  if (status === 'partial' && usedIn != null && quote.swapIn > 0n) return (quote.fee * usedIn) / quote.swapIn;
  return 0n;
}

function usedAmount(outcomes: NearRelayOutcome[], txs: NearCall[]): bigint | null {
  let used = 0n;
  for (let i = 0; i < txs.length; i++) {
    const last = txs[i].actions[txs[i].actions.length - 1];
    if (last?.params.methodName !== 'ft_transfer_call') continue;
    const v = outcomes[i]?.result?.SuccessValue;
    if (typeof v !== 'string') return null;
    try {
      const n = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
      if (typeof n !== 'string' || !/^\d+$/.test(n)) return null;
      used += BigInt(n);
    } catch {
      return null;
    }
  }
  return used;
}

/**
 * Sends a quote: re-quotes (and so re-checks) when it's stale, checks the
 * route once more against exactly what's shown, makes sure the wallet
 * holds what it's spending and the NEAR its storage needs, sends the swap
 * through Mango's relayer, reads what really happened, and only then
 * sends Mango's fee.
 */
export async function executeNearTrade(
  session: DerivedAccounts,
  initial: NearTradeQuote,
  {
    send = sendSponsoredNearCalls,
    view = nearView,
    rpc = nearRpc,
    ensureAccount = ensureNearAccount,
    requote,
    fetchImpl = fetch,
    now = () => Date.now(),
  }: {send?: Send; view?: View; rpc?: Rpc; ensureAccount?: typeof ensureNearAccount; requote?: () => Promise<NearTradeQuote>; fetchImpl?: typeof fetch; now?: () => number} = {},
): Promise<NearTradeResult> {
  if (!session.near) throw new NearTradeError('This wallet has no NEAR account.');
  const accountId = session.near.address;
  const fresh = requote ?? (() => quoteNearTrade({side: initial.side, token: initial.token, payUnits: initial.payUnits, accountId, slippageBps: initial.slippageBps, fetchImpl}));
  const quote = now() - initial.quotedAt > NEAR_QUOTE_MAX_AGE_MS ? await fresh() : initial;
  if (quote.side !== initial.side || quote.token !== initial.token || quote.payUnits !== initial.payUnits) throw new NearTradeError('The trade changed — try again.');
  // Never send for less than the minimum the user was shown.
  if (quote.minReceiveUnits < initial.minReceiveUnits) throw new NearTradeError('The price moved since your quote — check the new amount and try again.');
  const {route} = quote;
  const staged = quote.stages;
  if (staged) {
    for (let i = 0; i < staged.length; i++) {
      const stage = staged[i];
      assertIntearRouteSafe(stage.route.txs, {
        accountId,
        tokenIn: stage.tokenIn,
        tokenOut: stage.tokenOut,
        amountIn: i === 0 ? quote.swapIn : stage.route.minOut,
        minOut: stage.route.minOut,
      });
    }
  } else {
    assertIntearRouteSafe(route.txs, {
      accountId,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.swapIn,
      minOut: route.minOut,
    });
  }
  const stageRoutes = staged?.map(stage => stage.route) ?? [route];

  const balanceIn = await fetchNearTokenBalance(quote.tokenIn, accountId, view);
  if (balanceIn < quote.payUnits) throw new NearTradeError(quote.side === 'buy' ? 'Not enough USDC on NEAR for this trade.' : "You don't hold that much of this token.");
  // A new NEAR account only exists once Mango's relayer has set it up
  // (with starter NEAR) — do that before counting its NEAR.
  await ensureAccount(session, {rpc});
  const needNear = stageRoutes.reduce((sum, r) => sum + attachedNear(r.txs), 0n);
  if (needNear > 0n && needNear > (await spendableNear(accountId, rpc))) {
    throw new NearTradeError("Your NEAR account doesn't have enough NEAR to register this token (a one-time storage deposit).");
  }

  if (staged) {
    // Capture the existing intermediate balance before the first leg so an
    // already-held wNEAR is never accidentally spent.
    const intermediateBefore = await fetchNearTokenBalance(WRAP_NEAR, accountId, view);
    // Execute the bridge leg first. We intentionally spend only its shown
    // minimum on the DCL leg so an unexpectedly better fill is never swept.
    const first = staged[0];
    const firstSent = await send(session, first.route.txs);
    const firstVerdict = classifySwapOutcomes(first.route.txs, firstSent);
    const firstHashes = [...firstVerdict.hashes];
    if (firstVerdict.status !== 'ok') {
      return {status: firstVerdict.status, hashes: firstHashes, feeCharged: 0n, feeError: null};
    }

    // Read the actual newly acquired wNEAR, then quote the DCL leg again.
    // Existing wNEAR in the wallet is never touched.
    const available = await fetchNearTokenBalance(WRAP_NEAR, accountId, view);
    const acquired = available > intermediateBefore ? available - intermediateBefore : first.route.minOut;
    if (acquired < first.route.minOut) throw new NearTradeError('The first routing leg returned less than its guaranteed minimum.');
    const secondRoutes = await fetchIntearRoutes({
      tokenIn: WRAP_NEAR,
      tokenOut: quote.tokenOut,
      amountIn: acquired,
      slippageBps: quote.slippageBps,
      accountId,
      fetchImpl,
    });
    const second = pickRelayableRoute(secondRoutes, {
      accountId,
      tokenIn: WRAP_NEAR,
      tokenOut: quote.tokenOut,
      amountIn: acquired,
    });
    if (!second || second.minOut < quote.minReceiveUnits) {
      throw new NearTradeError('The price moved while routing through wNEAR — nothing further was sent.');
    }
    assertIntearRouteSafe(second.txs, {
      accountId,
      tokenIn: WRAP_NEAR,
      tokenOut: quote.tokenOut,
      amountIn: acquired,
      minOut: second.minOut,
    });
    const secondSent = await send(session, second.txs);
    const secondVerdict = classifySwapOutcomes(second.txs, secondSent);
    const hashes = [...firstHashes, ...secondVerdict.hashes];
    if (secondVerdict.status !== 'ok') {
      return {status: secondVerdict.status, hashes, feeCharged: 0n, feeError: null};
    }
    const fee = quote.fee;
    let feeError: string | null = null;
    let feeCharged = 0n;
    if (fee > 0n) {
      try {
        const registration = await storageRegistration(NEAR_USDC, DEV_FEE_WALLET_NEAR, view);
        const call = feeTransaction({token: NEAR_USDC, fee, feeAccount: DEV_FEE_WALLET_NEAR, feeRegistration: registration});
        if (call) {
          const [feeOutcome] = await send(session, [call]);
          if (feeOutcome?.hash) hashes.push(feeOutcome.hash);
          if (feeOutcome?.result && 'Failure' in feeOutcome.result) throw new Error("The fee transfer didn't go through.");
          feeCharged = fee;
        }
      } catch (err) {
        feeError = err instanceof Error ? err.message : "Mango's fee couldn't be sent.";
      }
    }
    return {status: 'ok', hashes, feeCharged, feeError};
  }

  const sent = await send(session, route.txs);
  const verdict = classifySwapOutcomes(route.txs, sent);
  const fee = feeAfterSwap(quote, verdict.status, usedAmount(sent, route.txs));
  let feeError: string | null = null;
  let feeCharged = 0n;
  const hashes = [...verdict.hashes];
  if (fee > 0n) {
    try {
      const registration = await storageRegistration(NEAR_USDC, DEV_FEE_WALLET_NEAR, view);
      const call = feeTransaction({token: NEAR_USDC, fee, feeAccount: DEV_FEE_WALLET_NEAR, feeRegistration: registration});
      if (call) {
        const [feeOutcome] = await send(session, [call]);
        if (feeOutcome?.hash) hashes.push(feeOutcome.hash);
        if (feeOutcome?.result && 'Failure' in feeOutcome.result) throw new Error("The fee transfer didn't go through.");
        feeCharged = fee;
      }
    } catch (err) {
      feeError = err instanceof Error ? err.message : "Mango's fee couldn't be sent.";
    }
  }
  return {status: verdict.status, hashes, feeCharged, feeError};
}

export {IntearRouteError, NearSendError};
