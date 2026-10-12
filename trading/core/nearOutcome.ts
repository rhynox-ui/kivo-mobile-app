// src/core/nearOutcome.ts
//
// A TypeScript port of the site's src/nearOutcome.js (mango-bridge.jsx):
// what a batch of NEAR swap calls actually did. On NEAR a swap that
// misses its minimum doesn't fail the transaction: the exchange rejects
// the tokens inside ft_transfer_call and the token contract returns them
// (NEP-141 ft_resolve_transfer). The call still "succeeds", and its
// return value is the amount the exchange actually kept — 0 when the
// whole swap was cancelled. Reading that value is the only way to tell
// the user the truth instead of "Bought" for a refunded swap.
//
// The one difference from the site: Mango Pro sends through Mango's gas
// relayer, whose own transaction status only says the relay was accepted
// (NEP-366 — the user's calls run in a separate receipt). The relayer
// returns the user's own calls' final status as `result`
// (near-relayer.js delegatedResult); that is what's read here.

import type {NearCall, NearRelayOutcome} from './nearSigning.ts';

export type SwapOutcomeStatus = 'ok' | 'partial' | 'refunded' | 'failed' | 'unknown';

function decodeUsedAmount(successValue: unknown): bigint | null {
  if (typeof successValue !== 'string') return null;
  try {
    const v = JSON.parse(Buffer.from(successValue, 'base64').toString('utf8'));
    return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

/**
 * `txs` are the calls that were sent, in order; `outcomes` what the relay
 * returned for each; `skip` holds indexes to leave out of the verdict.
 */
export function classifySwapOutcomes(txs: NearCall[], outcomes: NearRelayOutcome[] | null | undefined, {skip = []}: {skip?: number[]} = {}): {status: SwapOutcomeStatus; hashes: string[]} {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const hashes = list.map(o => o?.hash).filter((h): h is string => typeof h === 'string' && h.length > 0);
  if (list.length < txs.length) return {status: 'unknown', hashes};
  let refunded = false;
  let partial = false;
  for (let i = 0; i < txs.length; i++) {
    if (skip.includes(i)) continue;
    const st = list[i]?.result as Record<string, unknown> | null | undefined;
    if (!st || typeof st !== 'object') return {status: 'unknown', hashes};
    if ('Failure' in st) return {status: 'failed', hashes};
    const actions = txs[i].actions;
    const last = actions[actions.length - 1];
    if (last?.params?.methodName !== 'ft_transfer_call') continue;
    const used = decodeUsedAmount(st.SuccessValue);
    if (used === null) return {status: 'unknown', hashes};
    const sent = BigInt(String(last.params.args.amount));
    if (used === 0n) refunded = true;
    else if (used < sent) partial = true;
  }
  return {status: refunded ? 'refunded' : partial ? 'partial' : 'ok', hashes};
}
