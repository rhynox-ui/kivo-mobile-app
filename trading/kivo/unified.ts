// Unified-balance buys for Kivo mobile (FOMO-style "use everything I hold"),
// grown from mango-pro's TokenTradeScreen multi-source plan.
//
// The user sees ONE balance in dollars (USDC/USDG on every network, see
// spendable.ts fetchTradeCash) and never picks a chain. Only cash is ever
// spent: native coins and other tokens are holdings, never a buy's source. Relay still needs
// one concrete origin per quote, so a buy is split into legs underneath: each
// leg spends one asset on one network and routes straight to the token's
// chain (no separate bridging step, nothing left stranded half-way).
// Rules:
//   - cash is drawn in spendOrder: the token's own network first, then
//     Solana (home), then the largest balances, Ethereum mainnet last;
//   - a gas-free EVM leg Kivo's server would not sponsor (requireSponsored)
//     is dropped like an unroutable one, so cash elsewhere covers it;
//   - all legs are quoted at once; a leg that can't be routed (no route,
//     price impact beyond ±50%) is dropped and the next asset fills its gap;
//   - Kivo's fee is computed on the whole order and shared across the legs
//     (feeBasisUsd), so splitting a buy never costs more in fees;
//   - if the balance can't be fully routed the plan is refused with a
//     PartialRouteError saying how much CAN be bought, so the screen can offer
//     that amount instead of a dead end.
// Every leg is a normal gasless Kivo quote, so each one still passes the
// intent firewall before the device signs it.

import type {ChainKey} from '../core/chainData';
import {recordDiagnosticEvent} from '../../src/debug/diagnosticLog';
import {requestKivoQuote, type KivoQuote, type KivoQuoteView} from './quote';
import {quoteSponsorshipStatus} from '../core/relayQuote';
import type {DirectPlan} from './direct';
import type {KivoToken} from './tokens';
import {assetLabel, spendOrder, spendableFor, type SpendableAsset, type SpendableBalance, type SpendableKind} from './spendable';

export type UnifiedLeg = {chainKey: ChainKey; amountUsd: number; quote: KivoQuote; asset: {symbol: string; address: string; kind: SpendableKind | 'token'}};
export type UnifiedPlan = {legs: UnifiedLeg[]; view: KivoQuoteView; /** Same-network trade straight on Uniswap (Relay pays gas); legs is empty. */ direct?: DirectPlan};

const EXTREME_PRICE_IMPACT_PCT = 50;
const MIN_LEG_USD = 0.05;

/** The balance could only partly cover the buy: coveredUsd is what can be bought. */
export class PartialRouteError extends Error {
  coveredUsd: number;
  failures: {label: string; reason: string}[];
  constructor(message: string, coveredUsd: number, failures: {label: string; reason: string}[]) {
    super(message);
    this.name = 'PartialRouteError';
    this.coveredUsd = coveredUsd;
    this.failures = failures;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'No route.');
}

/** A leg sent gas-free through Kivo's /execute: EVM origin without Solana instructions. */
export function legNeedsSponsorship(quote: KivoQuote, originChain: ChainKey): boolean {
  if (originChain === 'solana') return false;
  return !(quote.quote.steps ?? []).some(step => (step.items ?? []).some(item => Boolean(item.data?.instructions)));
}

/** Units of `asset` worth legUsd; the whole spendable amount when the leg takes all of it. */
export function legUnits(asset: SpendableAsset, legUsd: number): string {
  const units = legUsd >= asset.valueUsd - 1e-9 ? asset.spendableAmount : legUsd / asset.priceUsd;
  return floorUsdAmount(Math.min(units, asset.spendableAmount), asset.decimals);
}

/**
 * What a buy may draw from, in order: USDC/USDG only (never native coins or
 * other tokens), never the coin being bought, Solana only with a Solana wallet.
 */
export function buyPool(balance: SpendableBalance, token: {chainKey: ChainKey; tokenAddress: string}, solanaAddress?: string): SpendableAsset[] {
  return spendOrder(spendableFor(balance, token).assets.filter(asset => asset.kind === 'cash' && asset.valueUsd >= MIN_LEG_USD && (asset.chainKey !== 'solana' || Boolean(solanaAddress))), token.chainKey);
}

export async function planUnifiedBuy(params: {
  token: KivoToken & {chainKey: ChainKey};
  amountUsd: number;
  userAddress: string;
  solanaAddress?: string;
  tokenDecimals?: number;
  balance: SpendableBalance;
  slippageBps?: number;
  /** Drop gas-free EVM legs whose quote Kivo's server did not sponsor (the wallet holds no gas). */
  requireSponsored?: boolean;
}): Promise<UnifiedPlan> {
  const {token, amountUsd, userAddress, solanaAddress, tokenDecimals = 18, balance, slippageBps, requireSponsored = false} = params;
  if (token.chainKey === 'solana' && !solanaAddress) throw new Error('This wallet has no Solana address for this route.');
  // Never pay for a coin with itself (buying ETH on Base doesn't spend ETH on Base).
  const pool = buyPool(balance, token, solanaAddress);
  let remainingUsd = amountUsd;
  const legs: UnifiedLeg[] = [];
  const failures: {label: string; reason: string}[] = [];

  const quoteLeg = async (asset: SpendableAsset, legUsd: number): Promise<UnifiedLeg> => {
    const quote = await requestKivoQuote({
      // Relay's `user` is the wallet that signs on the ORIGIN chain.
      side: 'buy', token, amount: legUnits(asset, legUsd), userAddress: asset.chainKey === 'solana' ? solanaAddress! : userAddress, payChain: asset.chainKey,
      payAsset: {chainKey: asset.chainKey, address: asset.address, symbol: asset.symbol, decimals: asset.decimals},
      recipientAddress: token.chainKey === 'solana' ? solanaAddress : userAddress,
      // Kivo's sponsored EVM calls can't carry native value, so a leg spending
      // ETH/BNB/… is sent by the wallet itself, paying gas from that coin's reserve.
      tokenDecimals, slippageBps, execution: asset.kind === 'native' && asset.chainKey !== 'solana' ? 'wallet' : 'gasless', amountUsd: legUsd, feeBasisUsd: amountUsd,
    });
    const impact = quote.view.priceImpactPct;
    if (impact != null && Math.abs(impact) > EXTREME_PRICE_IMPACT_PCT) {
      void recordDiagnosticEvent('kivo.blocked-high-impact-route', new Error('A route was blocked by the extreme price-impact guard.'));
      throw new Error(Math.abs(impact) >= 100 ? 'fees on this route are more than the amount itself' : `fees and price impact would take about ${Math.round(Math.abs(impact))}% of this part`);
    }
    if (quote.view.unsupportedReason) throw new Error(quote.view.unsupportedReason);
    if (requireSponsored && legNeedsSponsorship(quote, asset.chainKey) && !(quoteSponsorshipStatus(quote.quote) ?? '').startsWith('on')) {
      throw new Error('Kivo can\'t pay the network fee for this part right now');
    }
    const out = quote.view.receive.usd ?? Number(quote.view.receive.amount ?? NaN);
    if (!(out > 0)) throw new Error('the route returned no output');
    return {chainKey: asset.chainKey, amountUsd: legUsd, quote, asset: {symbol: asset.symbol, address: asset.address, kind: asset.kind}};
  };

  // Quote a batch of assets that together cover what is left; drop the ones
  // that can't be routed and fill their share from the next assets in order.
  while (remainingUsd > 0.01 && pool.length) {
    const batch: {asset: SpendableAsset; legUsd: number}[] = [];
    let need = remainingUsd;
    while (need > 0.01 && pool.length) {
      const asset = pool.shift()!;
      const legUsd = Math.min(need, asset.valueUsd);
      if (legUsd < MIN_LEG_USD) continue;
      batch.push({asset, legUsd});
      need -= legUsd;
    }
    if (!batch.length) break;
    const settled = await Promise.allSettled(batch.map(item => quoteLeg(item.asset, item.legUsd)));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') { legs.push(outcome.value); remainingUsd -= outcome.value.amountUsd; }
      else failures.push({label: assetLabel(batch[index].asset), reason: reasonOf(outcome.reason)});
    });
  }

  if (remainingUsd > 0.01 || !legs.length) {
    const covered = Math.max(0, amountUsd - remainingUsd);
    const why = failures.length ? ` Not routable: ${failures.map(f => `${f.label} (${f.reason})`).join('; ')}.` : '';
    throw new PartialRouteError(covered > 0.01
      ? `Only $${covered.toFixed(2)} of the $${amountUsd.toFixed(2)} could be routed from your balance.${why}`
      : `No route could cover this amount from your balance.${why}`, covered, failures);
  }
  return {legs, view: combinedView(legs)};
}

/**
 * Runs every leg: networks in parallel (one confirmation already covered them
 * all), legs on the same network one after another so their nonces never
 * collide. Never throws: each leg reports its own outcome.
 */
export async function runLegsByNetwork<T>(legs: UnifiedLeg[], run: (leg: UnifiedLeg, index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(legs.length);
  const byChain = new Map<ChainKey, number[]>();
  legs.forEach((leg, index) => byChain.set(leg.chainKey, [...(byChain.get(leg.chainKey) ?? []), index]));
  await Promise.all([...byChain.values()].map(async indexes => {
    for (const index of indexes) {
      try { results[index] = {status: 'fulfilled', value: await run(legs[index], index)}; }
      catch (reason) { results[index] = {status: 'rejected', reason}; }
    }
  }));
  return results;
}

/** One plan shown as one trade: sums across legs, earliest expiry, weighted impact. */
export function combinedView(legs: UnifiedLeg[]): KivoQuoteView {
  const views = legs.map(leg => leg.quote.view);
  const first = views[0];
  if (views.length === 1) return first;
  const sum = (values: (number | null)[]) => (values.every(v => v == null) ? null : values.reduce<number>((acc, v) => acc + (v ?? 0), 0));
  const payUsd = sum(views.map(v => v.pay.usd));
  const impactWeight = views.reduce((acc, v) => acc + (v.pay.usd ?? 0), 0);
  const weightedImpact = impactWeight > 0 && views.every(v => v.priceImpactPct != null)
    ? views.reduce((acc, v) => acc + (v.priceImpactPct ?? 0) * (v.pay.usd ?? 0), 0) / impactWeight
    : null;
  const networks = new Set(legs.map(leg => leg.chainKey)).size;
  return {
    ...first,
    routeLabel: `Your balance · ${views.length} assets${networks > 1 ? ` on ${networks} networks` : ''}`,
    crossChain: views.some(v => v.crossChain),
    // Several assets can't be summed in one unit, so a split buy is shown in dollars.
    pay: {...first.pay, symbol: 'USD', amount: legs.reduce((acc, leg) => acc + leg.amountUsd, 0).toFixed(2), usd: payUsd},
    receive: {...first.receive, amount: String(sum(views.map(v => (v.receive.amount == null ? null : Number(v.receive.amount)))) ?? ''), usd: sum(views.map(v => v.receive.usd))},
    minimumReceived: views.every(v => v.minimumReceived != null) ? String(views.reduce((acc, v) => acc + Number(v.minimumReceived), 0)) : null,
    priceImpactPct: weightedImpact,
    totalFeeUsd: sum(views.map(v => v.totalFeeUsd)),
    fees: {gasUsd: sum(views.map(v => v.fees.gasUsd)), relayerUsd: sum(views.map(v => v.fees.relayerUsd)), appUsd: sum(views.map(v => v.fees.appUsd))},
    etaSeconds: views.every(v => v.etaSeconds != null) ? Math.max(...views.map(v => v.etaSeconds as number)) : null,
    quotedAt: Math.min(...views.map(v => v.quotedAt)),
    expiresAt: Math.min(...views.map(v => v.expiresAt)),
    transactionCount: views.reduce((acc, v) => acc + v.transactionCount, 0),
    unsupportedReason: views.find(v => v.unsupportedReason)?.unsupportedReason ?? null,
  };
}

/**
 * An amount (dollars, or a coin's units) as a decimal string that never exceeds the float it came
 * from. toFixed(18) on a float invents digits (1.1 -> 1.100000000000000089),
 * which asked to spend more than an 18-decimal balance (BNB Chain USDC) held.
 */
export function floorUsdAmount(value: number, decimals: number): string {
  const places = Math.min(6, Math.max(2, decimals));
  const scale = 10 ** places;
  // The tiny epsilon only absorbs float noise (0.3 * 1e6 = 299999.99999999994).
  const floored = Math.floor(value * scale + 1e-6) / scale;
  return Math.max(0, floored).toFixed(places);
}
