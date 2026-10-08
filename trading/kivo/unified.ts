// Unified-cash buys for Kivo mobile, ported from mango-pro's
// TokenTradeScreen multi-source plan.
//
// The user sees ONE USDC balance (every supported chain added together) and
// never picks a chain. Relay still needs one concrete origin chain per quote,
// so a buy is split into legs underneath: each leg spends USDC on one chain
// and routes straight to the token's chain (no separate bridging step).
// Mango's rules:
//   - the token's own chain goes first, then the largest balances;
//   - for each slice of the amount, every chain that can cover it is quoted
//     and the one giving the most output per dollar wins (ties: lower fees,
//     then lower price impact);
//   - a leg with price impact beyond ±50% is never used;
//   - if the balance can't be fully routed, the buy is refused (no partial).
// Every leg is a normal gasless Kivo quote, so each one still passes the
// intent firewall before the device signs it.

import type {ChainKey} from '../core/chainData';
import type {CashBalanceRow} from './balances';
import {requestKivoQuote, type KivoQuote, type KivoQuoteView} from './quote';
import type {KivoToken} from './tokens';
import {spendableCash} from './balances';

export type UnifiedLeg = {chainKey: ChainKey; amountUsd: number; quote: KivoQuote};
export type UnifiedPlan = {legs: UnifiedLeg[]; view: KivoQuoteView};

const EXTREME_PRICE_IMPACT_PCT = 50;
const MIN_LEG_USD = 0.05;

function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** Cash per chain that can be spent, sorted the way Mango picks sources. */
export function cashContributors(cash: CashBalanceRow[], tokenChain: ChainKey): {chainKey: ChainKey; balance: number; address: string; symbol: string; decimals: number}[] {
  return cash
    .filter((row): row is CashBalanceRow & {status: 'ok'} => row.status === 'ok' && row.balance.amount > 0)
    .map(row => ({chainKey: row.chainKey, balance: floor2(spendableCash(row.chainKey, row.balance.amount)), address: row.balance.tokenAddress, symbol: row.balance.symbol, decimals: row.balance.decimals}))
    .filter(item => item.balance >= MIN_LEG_USD)
    .sort((a, b) => (a.chainKey === tokenChain ? -1 : b.chainKey === tokenChain ? 1 : b.balance - a.balance));
}

export function totalSpendableCash(cash: CashBalanceRow[] | null, tokenChain: ChainKey): number {
  return cash ? floor2(cashContributors(cash, tokenChain).reduce((sum, item) => sum + item.balance, 0)) : 0;
}

export async function planUnifiedBuy(params: {
  token: KivoToken & {chainKey: ChainKey};
  amountUsd: number;
  userAddress: string;
  cash: CashBalanceRow[];
  slippageBps?: number;
}): Promise<UnifiedPlan> {
  const {token, amountUsd, userAddress, cash, slippageBps} = params;
  const remaining = cashContributors(cash, token.chainKey);
  let remainingUsd = amountUsd;
  const legs: UnifiedLeg[] = [];
  let lastError: unknown = null;

  type Candidate = {chainKey: ChainKey; legUsd: number; quote: KivoQuote; score: number; feeUsd: number; impact: number};

  const quoteCandidates = async (contributors: typeof remaining): Promise<Candidate[]> => {
    const settled = await Promise.allSettled(contributors.map(async contributor => {
      const legUsd = floor2(Math.min(remainingUsd, contributor.balance));
      if (legUsd < MIN_LEG_USD) throw new Error('leg too small');
      const quote = await requestKivoQuote({
        side: 'buy', token, amount: legUsd.toFixed(2), userAddress, payChain: contributor.chainKey,
        tokenDecimals: 18, slippageBps, execution: 'gasless',
      });
      const impact = quote.view.priceImpactPct;
      if (impact != null && Math.abs(impact) > EXTREME_PRICE_IMPACT_PCT) throw new Error('route price impact too high');
      if (quote.view.unsupportedReason) throw new Error(quote.view.unsupportedReason);
      const outUsd = quote.view.receive.usd;
      const outAmount = Number(quote.view.receive.amount ?? NaN);
      const score = outUsd != null && outUsd > 0 ? outUsd / legUsd : Number.isFinite(outAmount) && outAmount > 0 ? outAmount / legUsd : 0;
      if (!(score > 0)) throw new Error('quote returned no output');
      return {chainKey: contributor.chainKey, legUsd, quote, score, feeUsd: quote.view.totalFeeUsd ?? Number.POSITIVE_INFINITY, impact: Math.abs(impact ?? 0)};
    }));
    const ok = settled.filter((r): r is PromiseFulfilledResult<Candidate> => r.status === 'fulfilled').map(r => r.value);
    const firstError = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
    if (!ok.length && firstError && !legs.length) lastError = firstError;
    return ok.sort((a, b) => (Math.abs(b.score - a.score) > 1e-9 ? b.score - a.score : a.feeUsd !== b.feeUsd ? a.feeUsd - b.feeUsd : a.impact - b.impact));
  };

  while (remainingUsd > 0.000001 && remaining.length > 0) {
    const fullCover = remaining.filter(c => c.balance + 0.000001 >= remainingUsd);
    let candidates = await quoteCandidates(fullCover.length ? fullCover : remaining);
    if (!candidates.length && fullCover.length && fullCover.length < remaining.length) candidates = await quoteCandidates(remaining);
    if (!candidates.length) break;
    const best = candidates[0];
    legs.push({chainKey: best.chainKey, amountUsd: best.legUsd, quote: best.quote});
    remainingUsd = floor2(remainingUsd - best.legUsd);
    remaining.splice(remaining.findIndex(c => c.chainKey === best.chainKey), 1);
  }

  if (remainingUsd > 0.01 || !legs.length) {
    const covered = Math.max(0, amountUsd - remainingUsd);
    if (!legs.length && lastError) throw lastError;
    throw new Error(covered > 0
      ? `Could only route ${covered.toFixed(2)} USDC of the ${amountUsd.toFixed(2)} USDC requested from your balance.`
      : 'No route could cover this amount from your USDC.');
  }
  return {legs, view: combinedView(legs)};
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
  return {
    ...first,
    routeLabel: `Unified cash · ${views.length} chains`,
    crossChain: views.some(v => v.crossChain),
    pay: {...first.pay, amount: legs.reduce((acc, leg) => acc + leg.amountUsd, 0).toFixed(2), usd: payUsd},
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
