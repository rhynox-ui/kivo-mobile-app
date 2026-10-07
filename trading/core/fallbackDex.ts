// src/core/fallbackDex.ts
//
// Second-source same-chain swap execution — tried only when Relay itself
// has no route at all. Scoped port of mango-mobile's own
// src/bridge/fallbackDex.js: that file tries eight providers (four
// direct on-chain DEX routers — Uniswap V3/V4, SushiSwap V2, PancakeSwap
// V3 — plus four generic quote-proxy aggregators). This now carries over
// six of those eight: all four direct on-chain routers (their own real
// body of pool-key-derivation and Permit2 code lives in this app's own
// uniswapV3.ts/uniswapV4.ts/sushiswapV2.ts/pancakeswapV3.ts, ported
// faithfully rather than re-derived) plus the two generic providers that
// need no developer-account verification, 1inch and 0x. Still not
// ported: OKX and KyberSwap, mobile's other two generic providers — OKX
// needs a real account this app doesn't hold, and KyberSwap's own
// integration there was only ever verified against public docs, not a
// live account either; both stay a real, disclosed gap rather than
// guessed into working.
//
// Priority order matches mobile's own (uniswapV3.js's own header
// explains the reasoning in full): uniswap-v4 and uniswap-v3 first — no
// backend/API-key dependency at all, so neither can fail from a
// third-party outage or a bad key, and both are Robinhood Chain's real,
// primary liquidity. sushiswap-v2 and pancakeswap-v3 right after, same
// no-key shape. 1inch/0x last, since they're the ones with a real
// third-party dependency (their own API, proxied through the backend
// below).
//
// Quoting for 1inch/0x goes through mango-bridge.jsx's own backend proxy
// — same reason mobile's version does: both require a real developer
// API key in the request header, and a key shipped inside a decompilable
// mobile APK isn't a secret at all. This app holds none of its own; the
// site's server does. Same endpoint, provider names, and request/response
// shape mobile already uses in production — not a new integration to
// stand up, a client reusing one that already exists. The four on-chain
// providers need no such proxy at all — they call public, permissionless
// contracts directly, same as any other DeFi client.
//
// Approve-then-swap, not Relay's own self-executed appFees model: selling
// anything but the chain's native asset needs a real ERC-20 approve() to
// the provider's own router first (allowanceTarget from the quote) —
// skipped for a native sell (allowanceTarget is null then). Approves
// EXACTLY the amount this one swap needs, never an unlimited allowance —
// same reasoning mobile's own header gives (a rare fallback path, not a
// repeated integration, so there's no UX case for a standing approval).
//
// One real hardening beyond the mobile source, since this app already
// holds itself to a higher bar elsewhere (txIntentFirewall.ts,
// solanaTxIntent.ts): the swap transaction's to/data/value come directly
// from a third-party API relayed through the backend proxy and mobile's
// own executeFallbackQuote signs them with no pre-flight check at all.
// This version adds the same publicClient.call() simulate
// executeRelayQuote.ts's own sendRelayEvmStep already runs before every
// Relay-sourced transaction, plus a bound on the native value leaving
// the wallet — cheap, real protection against a malformed or hostile
// quote, not present in the source this was ported from.
//
// sweepFallbackFeeFromNativeBalance below closes the one gap flagged
// when this file was first written: mobile's own
// settleFallbackFeeFromNativeBalance sweeps Mango's fee separately when
// the winning provider didn't collect it inline (0x doesn't; 1inch's own
// Integrator Fee does) — that depended on a live native-asset USD price
// feed this app didn't have yet. walletPrices.ts now exists (same
// CoinGecko source mobile's own walletPrices.js uses), so this is ported
// too, same best-effort/fire-and-forget contract as the source: called
// AFTER a fallback trade has already succeeded, never blocks or affects
// it, and silently does nothing if the price, balance, or gas-reserve
// estimate isn't available.
//
// sweepFallbackFeeFromSolanaBalance further below closes a second,
// separately-confirmed gap: pump.fun/PumpSwap (this file's Solana
// fallback, above) collect no fee inline either, and — unlike the EVM
// fallback path — had no native-balance sweep at all until now, a real
// revenue gap this file's own header used to disclose rather than hide.
// Same fire-and-forget contract, same MIN_FALLBACK_FEE_USD floor, same
// doubled-reserve headroom logic, just against SOL/DEV_FEE_WALLET_SOLANA
// instead of an EVM chain's native asset/DEV_FEE_WALLET.

import {formatUnits, parseEther} from 'viem';
import {MAINNET_CHAIN_IDS, NATIVE_SYMBOL, currencyAddress, type ChainKey} from './chainData.ts';
import {DEV_FEE_MAX_USD, DEV_FEE_PCT, DEV_FEE_WALLET, DEV_FEE_WALLET_SOLANA, appFeeBps, isFeeExemptWallet} from './fees.ts';
import {fetchWalletPrices} from './walletPrices.ts';
import {resolveDexScreenerPair} from './dexScreener.ts';
import {assertFallbackTxMatchesIntent, assertZeroExSettlerRegistered} from './fallbackTxFirewall.ts';
import {estimateEvmNativeFeeReserve, estimateSolanaMaxReserveSol, fetchWalletNativeBalance, fetchWalletSolanaBalance} from '../wallet/walletRpc.ts';
import {formatAmountForInput} from '../wallet/useAvailableBalance.ts';
import {signerAndPublicClientForChain, writeContractAs, sendTransactionAs} from './evmSigner.ts';
import {executeUniswapV4Swap, quoteUniswapV4, uniswapV4SupportsChain} from './uniswapV4.ts';
import {executeUniswapV3Swap, quoteUniswapV3, uniswapV3SupportsChain} from './uniswapV3.ts';
import {executeSushiSwapV2Swap, quoteSushiSwapV2, sushiswapV2SupportsChain} from './sushiswapV2.ts';
import {executePancakeSwapV3Swap, quotePancakeSwapV3, pancakeswapV3SupportsChain} from './pancakeswapV3.ts';
import type {DerivedAccounts} from '../wallet/keys';

// pumpfun.ts/pumpswap.ts are dynamically imported at each call site below,
// never statically — same reason particleSigning.ts already is (see that
// file's own call sites): both pull in '@solana/web3.js' at their own top
// level, which this app's Jest config can't parse (its React Native
// preset resolves @solana/web3.js's own internal @solana/codecs-numbers
// dependency to an ESM .native.mjs build). A static import here would
// drag that into every screen that imports fallbackDex.ts, including
// App.test.tsx's render smoke test. sendUsdc.ts/executeRelayQuote.ts's
// own Solana functions already avoid '@solana/web3.js' at their top level
// for this exact reason — this follows the same established rule.

const FALLBACK_QUOTE_URL = 'https://mangoprotocol.site/api/v1/bridge/fallback-quote';
// Same RPC sendUsdc.ts and executeRelayQuote.ts already use for every
// other direct Solana call this app makes.
const SOLANA_RPC_URL = 'https://rpc.solanatracker.io/public';

export const FALLBACK_PROVIDERS = ['uniswap-v4', 'uniswap-v3', 'sushiswap-v2', 'pancakeswap-v3', '1inch', '0x'] as const;
export const SOLANA_FALLBACK_PROVIDERS = ['pump-fun', 'pump-swap'] as const;
export type FallbackProvider = (typeof FALLBACK_PROVIDERS)[number] | (typeof SOLANA_FALLBACK_PROVIDERS)[number];
type GenericFallbackProvider = '1inch' | '0x';

type RawFallbackQuote = {
  to: string;
  data: string;
  value?: string;
  gas?: string;
  allowanceTarget?: string | null;
  sellAmount?: string;
  buyAmount: string;
  feeCollectedInline?: boolean;
};

const ERC20_ALLOWANCE_ABI = [
  {type: 'function', name: 'allowance', inputs: [{name: 'owner', type: 'address'}, {name: 'spender', type: 'address'}], outputs: [{type: 'uint256'}], stateMutability: 'view'},
  {type: 'function', name: 'approve', inputs: [{name: 'spender', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'},
] as const;

function chainIdFor(chainKey: ChainKey): number {
  const chainId = MAINNET_CHAIN_IDS[chainKey];
  if (!chainId) throw new Error(`No fallback route support for ${chainKey} — this path only covers EVM chains.`);
  return chainId;
}

async function fetchFallbackQuote({
  provider,
  chainId,
  sellToken,
  buyToken,
  sellAmount,
  takerAddress,
  originAmountUsd,
}: {
  provider: GenericFallbackProvider;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  takerAddress: string;
  originAmountUsd?: number | null;
}): Promise<RawFallbackQuote> {
  // Same appFeeBps() every other quote path already uses — the backend
  // proxy forwards this rate as-is, converting to whatever unit each
  // provider's own API expects (see fallback-quote.js, mango-bridge.jsx).
  const feeBps = isFeeExemptWallet(takerAddress) ? '0' : appFeeBps(originAmountUsd);
  const res = await fetch(FALLBACK_QUOTE_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({provider, chainId, sellToken, buyToken, sellAmount, takerAddress, feeBps, feeWallet: DEV_FEE_WALLET}),
  });
  const json = (await res.json().catch(() => ({}))) as {error?: string; data?: RawFallbackQuote};
  if (!res.ok || !json.data) {
    throw new Error(json?.error || `${provider} fallback quote failed (${res.status}).`);
  }
  return json.data;
}

/** Same real bug fix mobile's own header documents: a technically-real but functionally-worthless quote (a stale/near-empty pool) rounds to zero once formatted — treated as no quote at all, not a route. */
function quoteRoundsToZero(amountOut: bigint, buyDecimals: number | null | undefined): boolean {
  if (buyDecimals == null) return false;
  try {
    return Number(Number(formatUnits(amountOut, buyDecimals)).toFixed(4)) === 0;
  } catch {
    return false;
  }
}

// Solana same-chain fallback — pump.fun (bonding curve) and PumpSwap
// (post-graduation AMM), covering the common case for this token-first
// app: most Solana tokens traded here are pump.fun-origin, and Relay's
// own Solana routing goes through Jupiter under the hood, whose route
// construction for these newer, non-standard AMMs isn't reliable (a real,
// live "insufficient lamports" failure on mango-mobile, unrelated to
// actual network fees). Both are always SOL-quoted — a trade is either
// spending SOL to buy the token (sellToken is native SOL) or spending the
// token to receive SOL (buyToken is native SOL); a token-to-token pair
// has no pump.fun/PumpSwap route at all and falls straight through to the
// original Relay error, same as it already does today.
//
// Genuinely NOT covered: an ordinary Solana token with no pump.fun
// presence at all — that would need a real, separate direct Jupiter
// integration (Relay's own routing already goes through Jupiter
// internally, so there's no existing Jupiter client anywhere in this
// app's family to port from) — a disclosed gap, not guessed into working.
type SolanaTradeSide = 'buy' | 'sell';

function solanaTradeSideAndMint(params: {sellToken: string; buyToken: string}): {side: SolanaTradeSide; mintAddress: string} | null {
  const nativePlaceholder = currencyAddress('solana', NATIVE_SYMBOL.solana);
  const sellIsNative = params.sellToken === nativePlaceholder;
  const buyIsNative = params.buyToken === nativePlaceholder;
  if (sellIsNative === buyIsNative) return null; // both native or neither (token-to-token) — no pump.fun/PumpSwap route
  return sellIsNative ? {side: 'buy', mintAddress: params.buyToken} : {side: 'sell', mintAddress: params.sellToken};
}

type SolanaFallbackEntry = {provider: (typeof SOLANA_FALLBACK_PROVIDERS)[number]; buyAmount: bigint};

/**
 * Quotes both Solana providers in parallel (a token can only realistically
 * have an active bonding curve OR a graduated PumpSwap pool, never both —
 * pumpFunCurveForMint already returns null once complete, and a PumpSwap
 * pool only exists post-graduation — but this ranks by real output rather
 * than assuming that, same discipline quoteAllProviders above already
 * holds for the EVM side).
 */
async function quoteSolanaFallbackEntries(params: {sellToken: string; buyToken: string; sellAmount: string; takerAddress: string; buyDecimals?: number | null}): Promise<{entries: SolanaFallbackEntry[]; parsed: {side: SolanaTradeSide; mintAddress: string} | null}> {
  const parsed = solanaTradeSideAndMint(params);
  if (!parsed) return {entries: [], parsed: null};

  const [{Connection}, pumpfun, pumpswap] = await Promise.all([import('@solana/web3.js'), import('./pumpfun.ts'), import('./pumpswap.ts')]);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const amount = BigInt(params.sellAmount);

  const [pumpFunResult, pumpSwapResult] = await Promise.allSettled([
    parsed.side === 'buy'
      ? pumpfun.quotePumpFunBuy({connection, mintAddress: parsed.mintAddress, quoteBaseUnits: amount})
      : pumpfun.quotePumpFunSell({connection, mintAddress: parsed.mintAddress, amountBaseUnits: amount}),
    parsed.side === 'buy'
      ? pumpswap.quotePumpSwapBuy({connection, mintAddress: parsed.mintAddress, quoteBaseUnits: amount, userAddress: params.takerAddress})
      : pumpswap.quotePumpSwapSell({connection, mintAddress: parsed.mintAddress, amountBaseUnits: amount, userAddress: params.takerAddress}),
  ]);

  const entries: SolanaFallbackEntry[] = [];
  if (pumpFunResult.status === 'fulfilled' && pumpFunResult.value && !quoteRoundsToZero(pumpFunResult.value.amountOut, params.buyDecimals)) {
    entries.push({provider: 'pump-fun', buyAmount: pumpFunResult.value.amountOut});
  }
  if (pumpSwapResult.status === 'fulfilled' && pumpSwapResult.value && !quoteRoundsToZero(pumpSwapResult.value.amountOut, params.buyDecimals)) {
    entries.push({provider: 'pump-swap', buyAmount: pumpSwapResult.value.amountOut});
  }
  entries.sort((a, b) => (b.buyAmount > a.buyAmount ? 1 : b.buyAmount < a.buyAmount ? -1 : 0));
  return {entries, parsed};
}

// The on-chain providers' own quote shape carries what execution needs
// to replay the exact same pool/fee found at quote time, never
// re-deriving it (and possibly landing on a different pool) at execute
// time. sushiswap-v2 needs nothing extra — it has exactly one pool per
// pair, no fee tier or pool-key concept at all.
type OnchainExecData =
  | {kind: 'uniswap-v4'; poolKey: {currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}`}; zeroForOne: boolean}
  | {kind: 'uniswap-v3'; fee: number}
  | {kind: 'sushiswap-v2'}
  | {kind: 'pancakeswap-v3'; fee: number};

type ProviderEntry = {buyAmount: bigint} & ({provider: FallbackProvider; kind: 'onchain'; execData: OnchainExecData} | {provider: GenericFallbackProvider; kind: 'generic'; quote: RawFallbackQuote});

/**
 * Quotes every provider in parallel and ranks by real output — never
 * the first to answer, same real bug fix mobile's own header documents
 * (a worse-priced provider answering first used to lock in that price).
 * The four on-chain providers (see this file's own header for their
 * priority-order reasoning) are queried directly against their own
 * public contracts; the two generic ones (1inch/0x) go through the
 * backend quote proxy.
 */
async function quoteAllProviders({
  chainId,
  sellToken,
  buyToken,
  sellAmount,
  takerAddress,
  originAmountUsd,
  buyDecimals,
}: {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  takerAddress: string;
  originAmountUsd?: number | null;
  buyDecimals?: number | null;
}): Promise<{entries: ProviderEntry[]; failures: string[]}> {
  const sellAmountBig = BigInt(sellAmount);

  const attempts = FALLBACK_PROVIDERS.map(async (provider): Promise<ProviderEntry | null> => {
    if (provider === 'uniswap-v4') {
      if (!uniswapV4SupportsChain(chainId)) return null;
      const best = await quoteUniswapV4({chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig});
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return {provider, kind: 'onchain', buyAmount: best.amountOut, execData: {kind: 'uniswap-v4', poolKey: best.poolKey, zeroForOne: best.zeroForOne}};
    }
    if (provider === 'uniswap-v3') {
      if (!uniswapV3SupportsChain(chainId)) return null;
      const best = await quoteUniswapV3({chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig});
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return {provider, kind: 'onchain', buyAmount: best.amountOut, execData: {kind: 'uniswap-v3', fee: best.fee}};
    }
    if (provider === 'sushiswap-v2') {
      if (!sushiswapV2SupportsChain(chainId)) return null;
      const best = await quoteSushiSwapV2({chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig});
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return {provider, kind: 'onchain', buyAmount: best.amountOut, execData: {kind: 'sushiswap-v2'}};
    }
    if (provider === 'pancakeswap-v3') {
      if (!pancakeswapV3SupportsChain(chainId)) return null;
      const best = await quotePancakeSwapV3({chainId, tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmountBig});
      if (!best || quoteRoundsToZero(best.amountOut, buyDecimals)) return null;
      return {provider, kind: 'onchain', buyAmount: best.amountOut, execData: {kind: 'pancakeswap-v3', fee: best.fee}};
    }
    const quote = await fetchFallbackQuote({provider, chainId, sellToken, buyToken, sellAmount, takerAddress, originAmountUsd});
    const buyAmount = BigInt(quote.buyAmount ?? '0');
    if (quoteRoundsToZero(buyAmount, buyDecimals)) return null;
    return {provider, kind: 'generic', buyAmount, quote};
  });

  const settled = await Promise.allSettled(attempts);
  const entries: ProviderEntry[] = [];
  const failures: string[] = [];
  settled.forEach((result, i) => {
    const provider = FALLBACK_PROVIDERS[i];
    if (result.status === 'fulfilled' && result.value) {
      entries.push(result.value);
    } else if (result.status === 'rejected') {
      failures.push(`${provider}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  entries.sort((a, b) => (b.buyAmount > a.buyAmount ? 1 : b.buyAmount < a.buyAmount ? -1 : 0));
  return {entries, failures};
}

export type FallbackRouteParams = {
  chainKey: ChainKey;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  takerAddress: string;
  originAmountUsd?: number | null;
  buyDecimals?: number | null;
  /**
   * TradeSettingsSheet's own bps string (Relay-shaped, "50" = 0.5%), the
   * same value already sent straight to Relay's slippageTolerance field.
   * Real bug this closes: the on-chain fallback (Uniswap V4/V3/
   * SushiSwap V2/PancakeSwap V3) used to always compute its own
   * minAmountOut off a hardcoded 1% (UNISWAP_SLIPPAGE_BPS below) no
   * matter what the user picked here — a user who explicitly chose a
   * tighter tolerance had it silently widened back to 1% the moment
   * Relay had no route and this fallback took over. undefined/omitted
   * (Auto) still falls back to that same 1% default.
   */
  slippageBps?: string;
};

/**
 * Quote-only preview — the real gap this closes, same as mobile's own
 * checkFallbackRoute: without it, a token Relay hasn't indexed shows a
 * blank "—" receive amount right up to the moment a trade is attempted,
 * even though a fallback provider could actually quote and execute it.
 * null means neither provider can quote this pair, never a guess.
 *
 * unsupportedReason is set only for the Solana case where the pair
 * isn't even SOL<->token shaped (`parsed === null`) — pump.fun/PumpSwap
 * cover exactly that one shape, nothing else, so a USDC<->token pair on
 * this USDC-first product silently has no fallback at all the instant
 * Relay fails. Without this, the UI showed only Relay's own "no route"
 * message with no hint the fallback was even tried, reading as "nothing
 * exists for this trade" rather than "the one fallback here only covers
 * a narrower case than yours." Left unset when the pair IS SOL<->token
 * shaped but pump.fun/PumpSwap simply had nothing to quote — that case
 * has nothing extra worth saying beyond Relay's own message.
 */
export async function checkFallbackRoute(params: FallbackRouteParams): Promise<{provider: FallbackProvider; buyAmount: string} | {unsupportedReason: string} | null> {
  if (params.chainKey === 'solana') {
    const {entries, parsed} = await quoteSolanaFallbackEntries(params).catch(() => ({entries: [] as SolanaFallbackEntry[], parsed: null}));
    if (entries.length === 0) {
      return parsed === null
        ? {unsupportedReason: 'Kivo can only auto-route a Solana trade through pump.fun/PumpSwap when it pays or receives SOL directly — this pair needs a route Relay itself has to provide.'}
        : null;
    }
    const winner = entries[0];
    return {provider: winner.provider, buyAmount: winner.buyAmount.toString()};
  }
  const {entries} = await quoteAllProviders({chainId: chainIdFor(params.chainKey), ...params});
  if (entries.length === 0) return null;
  const winner = entries[0];
  return {provider: winner.provider, buyAmount: winner.buyAmount.toString()};
}

/**
 * Real gap this closes: Relay's own quote carries a priceImpactPct that
 * TokenTradeScreen.tsx's own extremePriceImpact gate blocks a trade on
 * above EXTREME_PRICE_IMPACT_PCT — this fallback path never computed
 * one at all (checkFallbackRoute's own caller sets it to null), so that
 * same safety gate silently never fired for a fallback trade no matter
 * how thin the actual pool was. A Relay-blocked 80%-impact trade could
 * sail straight through the fallback the instant Relay had no route.
 *
 * Deliberately does NOT implement separate spot-price math for each of
 * the four on-chain AMM types this file routes through (Uniswap V2's
 * constant-product formula, V3/V4's concentrated-liquidity math,
 * PancakeSwap V3's own) — four different formulas, each easy to get
 * subtly wrong in a way that either falsely blocks real trades or fails
 * to catch a genuinely bad one, and none of them would even cover the
 * two generic providers (1inch/0x) anyway. Instead exposes the token's
 * real live market price via dexScreener.ts's resolveDexScreenerPair —
 * the SAME trusted price source openPositions.ts already values a held
 * token against, already cached and already fails safe (null, never a
 * guess, never a throw) — so the caller can compare the trade's own
 * implied execution price against it. Works identically across every
 * provider this file has, present or future.
 *
 * Deliberately just the price lookup, not the full priceImpactPct
 * formula: Buy and Sell aren't mirror images of each other here — a Buy
 * compares against the known, fixed USD amount paid; a Sell compares
 * against the fair value of the (fixed) token amount being sold, which
 * uses this SAME price as both the denominator and part of the
 * numerator. Folding both into one "generic" formula here previously
 * produced a formula that was only actually correct for Buy — direction-
 * specific arithmetic is safer done explicitly at the call site, which
 * already knows isBuySide.
 *
 * Returns null whenever no live price is indexed for this token — the
 * caller must treat that exactly like Relay's own "couldn't compute
 * impact" case (quote.priceImpactPct: null), never as "impact is zero."
 */
export async function fetchLiveTokenPriceUsd({chainKey, tokenAddress}: {chainKey: ChainKey; tokenAddress: string}): Promise<number | null> {
  const pair = await resolveDexScreenerPair({chainKey, tokenAddress}).catch(() => null);
  const priceUsd = pair?.priceUsd;
  return priceUsd != null && Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

async function executeFallbackQuote({
  provider,
  chainKey,
  session,
  sellTokenAddress,
  buyTokenAddress,
  sellAmount,
  quote,
}: {
  provider: GenericFallbackProvider;
  chainKey: ChainKey;
  session: DerivedAccounts;
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: string;
  quote: RawFallbackQuote;
}): Promise<{hash: string}> {
  const {signer, publicClient} = signerAndPublicClientForChain(chainIdFor(chainKey), session);

  // Before anything is approved or signed: the provider's transaction
  // must be exactly this swap (fallbackTxFirewall.ts — canonical router,
  // decoded calldata, exact input, the wallet as recipient, a real
  // minimum). An eth_call below only proves it runs.
  const {settler} = assertFallbackTxMatchesIntent({
    provider,
    quote,
    sellToken: sellTokenAddress,
    buyToken: buyTokenAddress,
    sellAmount: BigInt(sellAmount),
    taker: signer.address,
  });
  if (settler) {
    await assertZeroExSettlerRegistered(settler, args => publicClient.readContract(args as never));
  }

  // Tracked so a swap that reverts below can clean up after itself — see
  // that catch block's own comment for why.
  let approvalJustSent = false;
  if (quote.allowanceTarget) {
    const currentAllowance = (await publicClient.readContract({
      address: sellTokenAddress as `0x${string}`,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [signer.address, quote.allowanceTarget as `0x${string}`],
    })) as bigint;
    const requiredAmount = BigInt(quote.sellAmount ?? sellAmount ?? '0');
    if (currentAllowance < requiredAmount) {
      const approveHash = await writeContractAs(signer, {
        address: sellTokenAddress as `0x${string}`,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [quote.allowanceTarget as `0x${string}`, requiredAmount],
      });
      await publicClient.waitForTransactionReceipt({hash: approveHash});
      approvalJustSent = true;
    }
  }

  const value = BigInt(quote.value ?? '0');
  // Real bound, not present in the mobile source this was ported from:
  // the native value this transaction spends should never exceed the
  // amount actually being sold (a native-asset sell) — a quote asking
  // to send materially more native value than the trade itself is a
  // sign of a malformed or hostile response, not a real swap.
  if (!sellTokenAddress || sellTokenAddress === '0x0000000000000000000000000000000000000000') {
    const sellAmountBig = BigInt(sellAmount);
    if (value > sellAmountBig) {
      throw new Error('This fallback quote asks to send more native value than the trade itself — refusing to sign.');
    }
  }

  const tx = {to: quote.to as `0x${string}`, data: quote.data as `0x${string}`, value};
  try {
    await publicClient.call({...tx, account: signer.address});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message && !/timeout|network|fetch|429|403/i.test(message)) {
      // Real, bounded cleanup: the approval above can only ever be
      // spent by this exact provider's own router, for exactly the
      // amount just approved (never unlimited) — so a leftover
      // allowance here is low-risk, not a drain vector. Still worth
      // reverting rather than leaving it live, since this quote is
      // being abandoned. Best-effort and fire-and-forget: never lets a
      // revoke failure change or delay the real error below, which is
      // what the caller actually needs to see.
      if (approvalJustSent && quote.allowanceTarget) {
        writeContractAs(signer, {address: sellTokenAddress as `0x${string}`, abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [quote.allowanceTarget as `0x${string}`, 0n]}).catch(() => {});
      }
      throw new Error(`This fallback transaction would revert: ${message}`);
    }
  }

  const swapHash = await sendTransactionAs(signer, {...tx, ...(quote.gas ? {gas: BigInt(quote.gas)} : {})});
  await publicClient.waitForTransactionReceipt({hash: swapHash});
  return {hash: swapHash};
}

export type FallbackExecuteParams = FallbackRouteParams & {session: DerivedAccounts};
export type FallbackExecuteResult = {provider: FallbackProvider; hash: string; buyAmount: string; feeCollectedInline: boolean};

// 1% — the default tolerance when the caller passes no slippageBps
// (Auto, same meaning Relay's own slippageTolerance gives it). Protects
// the swap from landing far worse than quoted between the quote call and
// the swap call below, without being so tight a normal price move
// between those two calls fails it.
const UNISWAP_SLIPPAGE_BPS = 100n;

/**
 * Quotes every provider (see quoteAllProviders above), then executes
 * against whichever gave the best price, falling through to the
 * next-best only if that execution itself fails. Throws once all of
 * them have failed, carrying every provider's own failure reason — the
 * caller's own catch already has the ORIGINAL Relay error to show
 * instead, since this only ever runs after that one failed first (see
 * TokenTradeScreen.tsx's own call site).
 */
export async function tryFallbackProviders(params: FallbackExecuteParams): Promise<FallbackExecuteResult> {
  if (params.chainKey === 'solana') {
    const {entries, parsed} = await quoteSolanaFallbackEntries(params);
    if (!parsed) {
      throw new Error('No fallback route available for this Solana pair — pump.fun/PumpSwap only cover a direct SOL<->token trade.');
    }
    const [{Connection}, pumpfun, pumpswap] = await Promise.all([import('@solana/web3.js'), import('./pumpfun.ts'), import('./pumpswap.ts')]);
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const amountBaseUnits = BigInt(params.sellAmount);
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        const {signature} =
          entry.provider === 'pump-fun'
            ? await pumpfun.executePumpFunTrade({connection, session: params.session, mintAddress: parsed.mintAddress, side: parsed.side, amountBaseUnits})
            : await pumpswap.executePumpSwapTrade({connection, session: params.session, mintAddress: parsed.mintAddress, side: parsed.side, amountBaseUnits});
        // Neither provider collects Mango's fee inline (no fee mechanism
        // built into either) — feeCollectedInline: false tells the
        // caller to run the post-success sweep, same contract as the
        // EVM path below. sweepFallbackFeeFromSolanaBalance (this
        // file's own SOL equivalent of sweepFallbackFeeFromNativeBalance)
        // closes what used to be a real, disclosed gap here.
        return {provider: entry.provider, hash: signature, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false};
      } catch (err) {
        failures.push(`${entry.provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`No fallback route available. ${failures.join(' | ')}`);
  }
  const chainId = chainIdFor(params.chainKey);
  const {entries, failures} = await quoteAllProviders({chainId, ...params});
  const sellAmountBig = BigInt(params.sellAmount);

  // Real bug fix, ported from mobile's own header: uniswap-v4/uniswap-v3/
  // sushiswap-v2/pancakeswap-v3 each spend their own on-chain approval
  // before the swap itself (v4 and pancakeswap-v3 even spend two, via
  // their own separate Permit2 deployments). If the best-priced
  // provider's quote succeeded and execution then throws, the approval
  // transaction very likely already landed — falling through to the
  // NEXT on-chain provider would spend yet another approval on top of
  // that. Once that's happened, skip the remaining on-chain providers
  // entirely and fall straight through to the generic aggregators
  // (1inch/0x), which aren't part of this approval cascade.
  let onchainApprovalSpent = false;
  const slippageBpsToUse = params.slippageBps ? BigInt(params.slippageBps) : UNISWAP_SLIPPAGE_BPS;

  for (const entry of entries) {
    if (entry.kind === 'onchain' && onchainApprovalSpent) continue;
    try {
      if (entry.kind === 'onchain') {
        const minAmountOut = entry.buyAmount - (entry.buyAmount * slippageBpsToUse) / 10000n;
        onchainApprovalSpent = true;
        // No inline fee collection on any of these four — none has a
        // fee mechanism built in — so all of them rely on
        // TokenTradeScreen.tsx's own post-success
        // sweepFallbackFeeFromNativeBalance call, same as a fallback
        // trade landing on 0x already does.
        if (entry.execData.kind === 'uniswap-v4') {
          const result = await executeUniswapV4Swap({chainId, session: params.session, tokenIn: params.sellToken, tokenOut: params.buyToken, amountIn: sellAmountBig, poolKey: entry.execData.poolKey, zeroForOne: entry.execData.zeroForOne, minAmountOut});
          return {provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false};
        }
        if (entry.execData.kind === 'uniswap-v3') {
          const result = await executeUniswapV3Swap({chainId, session: params.session, tokenIn: params.sellToken, tokenOut: params.buyToken, amountIn: sellAmountBig, fee: entry.execData.fee, minAmountOut});
          return {provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false};
        }
        if (entry.execData.kind === 'sushiswap-v2') {
          const result = await executeSushiSwapV2Swap({chainId, session: params.session, tokenIn: params.sellToken, tokenOut: params.buyToken, amountIn: sellAmountBig, minAmountOut});
          return {provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false};
        }
        const result = await executePancakeSwapV3Swap({chainId, session: params.session, tokenIn: params.sellToken, tokenOut: params.buyToken, amountIn: sellAmountBig, fee: entry.execData.fee, minAmountOut});
        return {provider: entry.provider, hash: result.hash, buyAmount: entry.buyAmount.toString(), feeCollectedInline: false};
      }
      // Generic provider (1inch/0x) — quote was already fetched by
      // quoteAllProviders above, re-executed against as-is.
      const result = await executeFallbackQuote({
        provider: entry.provider,
        chainKey: params.chainKey,
        session: params.session,
        sellTokenAddress: params.sellToken,
        buyTokenAddress: params.buyToken,
        sellAmount: params.sellAmount,
        quote: {...entry.quote, sellAmount: params.sellAmount},
      });
      return {provider: entry.provider, hash: result.hash, buyAmount: entry.quote.buyAmount, feeCollectedInline: !!entry.quote.feeCollectedInline};
    } catch (err) {
      failures.push(`${entry.provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No fallback route available. ${failures.join(' | ')}`);
}

// Dust floor — under this, the gas cost of a second, separate
// transaction would rival or exceed the fee itself, not worth sending.
// Same value mobile's own MIN_FALLBACK_FEE_USD uses.
const MIN_FALLBACK_FEE_USD = 0.05;

/**
 * Best-effort, fire-and-forget: collects Mango's fee separately when a
 * fallback trade landed on a provider that didn't collect it inline (0x
 * doesn't; 1inch's own Integrator Fee does — see TokenTradeScreen.tsx's
 * own call site, which only calls this when feeCollectedInline is
 * false). The swap has ALREADY succeeded by the time this ever runs, so
 * a failure or a deliberate skip here never affects it or gets shown to
 * the user. Sized off the same appFeeBps math every other quote path
 * uses, converted into the chain's own native currency via a live
 * price — skipped entirely, never billed at a guessed number, if that
 * price or a large-enough spare native balance (beyond a real gas
 * reserve for transacting again) isn't actually known.
 */
export async function sweepFallbackFeeFromNativeBalance({
  chainKey,
  evmAddress,
  session,
  originAmountUsd,
}: {
  chainKey: ChainKey;
  evmAddress: string;
  session: DerivedAccounts;
  originAmountUsd: number | undefined | null;
}): Promise<void> {
  if (isFeeExemptWallet(evmAddress)) return;
  if (!(originAmountUsd && originAmountUsd > 0)) return;
  const targetFeeUsd = Math.min(originAmountUsd * DEV_FEE_PCT, DEV_FEE_MAX_USD);
  if (!(targetFeeUsd >= MIN_FALLBACK_FEE_USD)) return;

  const nativeSymbol = NATIVE_SYMBOL[chainKey];
  const prices = await fetchWalletPrices('usd').catch(() => null);
  const nativePriceUsd = prices?.[nativeSymbol];
  if (!(nativePriceUsd && nativePriceUsd > 0)) return;
  const targetFeeNative = targetFeeUsd / nativePriceUsd;

  const freshBalance = await fetchWalletNativeBalance(chainKey, evmAddress).catch(() => null);
  if (freshBalance === null) return;
  const gasReserve = await estimateEvmNativeFeeReserve(chainKey).catch(() => 0);
  // Doubled for the same reason DexScreen.tsx's own handleMax doubles
  // it: this transfer is itself a second transaction after the swap, so
  // it needs its own gas headroom kept aside too, never eating into what
  // the user needs to transact again.
  const spareNative = freshBalance - gasReserve * 2;
  const feeToSend = Math.min(targetFeeNative, spareNative);
  if (!(feeToSend > 0)) return;

  const {signer, publicClient} = signerAndPublicClientForChain(chainIdFor(chainKey), session);
  const hash = await sendTransactionAs(signer, {to: DEV_FEE_WALLET as `0x${string}`, value: parseEther(formatAmountForInput(feeToSend))});
  await publicClient.waitForTransactionReceipt({hash});
}

/**
 * SOL equivalent of sweepFallbackFeeFromNativeBalance above, for a
 * Solana pump.fun/PumpSwap fallback trade (tryFallbackProviders' Solana
 * branch always returns feeCollectedInline: false — neither provider
 * has a fee mechanism built in). Same best-effort, fire-and-forget
 * contract: the swap has already succeeded by the time this runs, so a
 * skip or a failure here never affects it or surfaces to the user. Uses
 * a plain legacy Transaction (not the VersionedTransaction shape
 * executeRelayQuote.ts's Solana signing uses) since this is a single
 * SystemProgram transfer with no lookup tables or program instructions
 * to compile — the simplest correct shape for the job.
 */
export async function sweepFallbackFeeFromSolanaBalance({
  solanaAddress,
  session,
  originAmountUsd,
}: {
  solanaAddress: string;
  session: DerivedAccounts;
  originAmountUsd: number | undefined | null;
}): Promise<void> {
  if (isFeeExemptWallet(solanaAddress)) return;
  if (!(originAmountUsd && originAmountUsd > 0)) return;
  const targetFeeUsd = Math.min(originAmountUsd * DEV_FEE_PCT, DEV_FEE_MAX_USD);
  if (!(targetFeeUsd >= MIN_FALLBACK_FEE_USD)) return;

  const prices = await fetchWalletPrices('usd').catch(() => null);
  const solPriceUsd = prices?.[NATIVE_SYMBOL.solana];
  if (!(solPriceUsd && solPriceUsd > 0)) return;
  const targetFeeSol = targetFeeUsd / solPriceUsd;

  const freshBalance = await fetchWalletSolanaBalance(solanaAddress, {forceFresh: true}).catch(() => null);
  if (freshBalance === null) return;
  const reserve = await estimateSolanaMaxReserveSol().catch(() => null);
  if (reserve === null) return;
  // Doubled for the same reason sweepFallbackFeeFromNativeBalance above
  // doubles its own gas reserve: this transfer is itself a second
  // transaction after the swap, so it needs its own fee headroom kept
  // aside too, never eating into what the user needs to transact again.
  const spareSol = freshBalance - reserve * 2;
  const feeToSend = Math.min(targetFeeSol, spareSol);
  if (!(feeToSend > 0)) return;

  const [{Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction}, bs58Module] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  const bs58 = bs58Module.default;
  const lamports = Math.floor(feeToSend * LAMPORTS_PER_SOL);
  if (lamports <= 0) return;

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(session.solana.privateKey));
  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({recentBlockhash: blockhash, feePayer: keypair.publicKey}).add(
    SystemProgram.transfer({fromPubkey: keypair.publicKey, toPubkey: new PublicKey(DEV_FEE_WALLET_SOLANA), lamports}),
  );
  transaction.sign(keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
}
