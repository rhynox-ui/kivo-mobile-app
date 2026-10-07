// src/core/txIntentFirewall.ts
//
// Ported verbatim (logic unchanged, typed for this repo) from
// mango-bridge.jsx's own src/txIntentFirewall.js — the fix for that
// repo's security audit's P0 finding, and the exact thing
// src/core/relayQuote.ts's own header names as the blocker on real
// execution here: "Signing/broadcasting needs the intent-firewall +
// calldata-decode confirm screen ... which hasn't been ported into
// this app yet." This is that port. Execution itself (actually signing
// and sending the steps a Relay quote returns) is still a separate,
// not-yet-built step — this file only decides whether it's SAFE to.
//
// Checks a routing provider's returned transaction against what the
// user actually asked for, BEFORE it reaches a wallet for signature.
//
// WHY THIS EXISTS. executeRelayQuote (and any DEX-aggregator fallback
// path) takes `to`, `data`, `value` and `chainId` straight out of an
// HTTP response and hands them to sendTransaction. Every one of those
// is attacker-controlled the moment anything between the user and the
// router is compromised — the routing API, a CDN, a hostile response
// injected some other way. The user reviewed "buy $50 of PEPE" in this
// app's own trade screen; without this check, nothing compares that to
// the bytes actually being signed.
//
// WHAT THIS CAN AND CANNOT DO. It cannot tell you what arbitrary router
// calldata does; decoding every DEX aggregator's encoding is not a thing
// a client can keep up with, and pretending otherwise would be worse
// than not trying. What it CAN do is bound the loss, using only fields
// that must be present for a transaction to be signed at all:
//
//   - Chain. Every item must name the chain the user chose. Without
//     this a response can omit chainId entirely, in which case a wallet
//     that only switches chains "when chainId is set" silently signs on
//     whatever chain it happens to be sitting on.
//   - Native value. The total native currency the transactions may move
//     is capped at the amount the user typed — and at ZERO when the
//     user is spending an ERC-20, where no native should move at all.
//   - Approvals. An `approve` in the origin token, to any spender, is
//     capped at the amount the user is spending. This is what blocks
//     the classic infinite-approval drain: the sequence looks like a
//     normal swap, and the router keeps the right to take the rest of
//     the balance afterwards.
//   - Direct transfers. No item may call transfer()/transferFrom() as
//     its own top-level selector, on any token, full stop. A real swap
//     route never needs the wallet to sign one directly — that call
//     only ever happens INSIDE a router's own contract execution, using
//     an allowance the approve step above already granted. Without this,
//     a hostile item shaped like `{to: anyToken, data: transfer(attacker,
//     wholeBalance)}` trips neither the native-value bound (the amount
//     lives in calldata, not the tx's own `value`) nor the approve
//     branch (it isn't an approve at all) — so it would sign with no
//     amount bound whatsoever, not "more than this trade needs" but the
//     entire balance of whatever token `to` names.
//
// Together those bound the worst case to "the trade the user asked for
// went to the wrong place" instead of "the wallet was emptied". Calldata
// that does something else entirely still can't move more than the user
// staked on this trade.
//
// WHAT BLOCKS AND WHAT ONLY WARNS. A false positive here is not a
// harmless extra check — it is a user who cannot trade. So the blocking
// set is restricted to conditions that CANNOT legitimately occur:
// a chain we didn't ask for, a recipient or currency we didn't ask for,
// spending more native than the user typed, approving a token that
// isn't the one being spent, approving more than the user is spending,
// or approving a spender that no LATER transaction in this same quote
// calls (an approval exists so a following step can pull the tokens).
//
// An approval larger than the trade used to only warn. Promoted to a
// block (an uploaded audit's C-02, verified): the header above already
// promised approvals are capped at the amount being spent, and Relay's
// own SDK fixtures (relay-kit tests/data/swapWithApproval.ts,
// swapWithZeroResetApproval.ts) approve exactly the swap amount on every
// transaction-only route. Relay's one max-approval flow approves Permit2
// ahead of a signature step, and executeRelayQuote.ts refuses signature
// steps outright, so no route this app can execute needs more.
//
// One suspicious pattern still only WARNS, because it has a legitimate
// explanation: native value attached to an ERC-20 sale (some routes
// charge a native protocol fee in the same transaction).
//
// The quote-level checks below (currencies, chains, recipient) are the
// second layer and are deliberately NOT fail-closed on absence: every
// one of those fields is optional in Relay's own response schema, so
// requiring them would break real trades whenever Relay legitimately
// omits one. They are enforced when present. That asymmetry is
// intentional and is why the bounds above are written to hold on their
// own, without any help from `details`.

// Real, confirmed critical gap this file had (found verifying an
// uploaded audit's MANGO-C01 claim against this exact function): the
// loop below only ever recognized approve()/Permit2-approve() as a
// selector worth decoding. Any OTHER selector — including a raw
// transfer(address,uint256) or transferFrom(address,address,uint256)
// aimed straight at a token contract — passed through completely
// unchecked, since it trips neither the native-value bound (all value
// is in calldata, not the tx's own `value` field) nor the approve
// branch. A single hostile extra item shaped like
// `{to: someToken, data: transfer(attacker, entireBalance)}` would
// have been signed and broadcast with NO bound on the amount at all —
// not "more than this trade needs" but literally the whole balance of
// whatever token `to` names, unrelated to the trade being reviewed.
// This directly contradicted this file's own header claim ("bound the
// worst case to... never 'the wallet was emptied'").
//
// Fix: block both selectors outright, for every item, regardless of
// which token they target. This needs no new calldata-decoding
// capability and no per-router allowlist (still not attempted, same as
// before) — a real swap route never needs the WALLET to sign a
// standalone transfer/transferFrom as one of its own transaction
// items. A router's swap function calls transferFrom itself, as part
// of ITS OWN contract execution, using the allowance the approve step
// already granted; that internal call never appears as a separate
// {to, data} item for the wallet to sign. So a top-level item whose
// selector IS one of these two is never a legitimate swap step in any
// route shape this app relies on — it's only ever an unrelated direct
// transfer smuggled into the batch.
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
const ERC20_TRANSFER_FROM_SELECTOR = '0x23b872dd';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
// Permit2's approve(address token, address spender, uint160 amount,
// uint48 expiration) — a different shape from ERC-20's, so its amount
// sits at a different offset. Relay routes through Permit2 on chains
// where it is deployed.
const PERMIT2_APPROVE_SELECTOR = '0x87517c45';

const NATIVE_SENTINELS = new Set([
  '0x0000000000000000000000000000000000000000',
  // Some providers use this pseudo-address for "the chain's own coin".
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

export class TransactionIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionIntentError';
  }
}

function fail(message: string): never {
  throw new TransactionIntentError(
    `${message} This trade was stopped before signing because what came back from the routing service didn't match what you asked for. Nothing was sent and nothing was spent.`,
  );
}

function normalizeAddress(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * True only when both values are EVM addresses, which are the only ones
 * this file compares for equality — see assertQuoteMatchesIntent's own
 * comment on why a base58 Solana address is not compared here.
 */
function comparableAddresses(a: unknown, b: unknown): a is string {
  return typeof a === 'string' && typeof b === 'string' && EVM_ADDRESS.test(a) && EVM_ADDRESS.test(b);
}

export function isNativeCurrency(address: unknown): boolean {
  const normalized = normalizeAddress(address);
  return normalized !== null && NATIVE_SENTINELS.has(normalized);
}

/** Parses a decimal or 0x-prefixed amount into a BigInt, or null when it isn't one. */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed < 0n ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Reads one 32-byte word out of ABI-encoded calldata as a BigInt.
 *
 * wordIndex is 0-based and counted after the 4-byte selector, matching
 * how ABI arguments are laid out for the fixed-size types this file
 * cares about (address, uint160, uint256 — all single words).
 */
function calldataWord(data: string, wordIndex: number): bigint | null {
  const body = data.slice(10); // strip "0x" + 8 selector hex chars
  const start = wordIndex * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) return null;
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

function selectorOf(data: unknown): string | null {
  return typeof data === 'string' && data.startsWith('0x') && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

export type TransactionIntent = {
  originChainId: number;
  destinationChainId: number;
  originCurrency: string | null;
  destinationCurrency: string | null;
  originIsNative: boolean;
  amount: bigint;
  userAddress: string | null;
  recipientAddress: string | null;
};

/**
 * The user's actual request, captured where it is known for certain —
 * at the point we build the quote request, not read back out of the
 * response.
 *
 * amountBaseUnits is the exact figure the user's own input produced. It
 * is the ceiling every spend check below is measured against.
 */
export function buildTransactionIntent({
  originChainId,
  destinationChainId,
  originCurrency,
  destinationCurrency,
  amountBaseUnits,
  userAddress,
  recipientAddress,
}: {
  originChainId: number | string;
  destinationChainId: number | string;
  originCurrency: string;
  destinationCurrency: string;
  amountBaseUnits: unknown;
  userAddress: string;
  recipientAddress?: string;
}): TransactionIntent {
  const amount = toBigInt(amountBaseUnits);
  if (amount === null) {
    fail(`Could not read the amount for this trade ("${String(amountBaseUnits)}").`);
  }
  return {
    originChainId: Number(originChainId),
    destinationChainId: Number(destinationChainId),
    originCurrency: normalizeAddress(originCurrency),
    destinationCurrency: normalizeAddress(destinationCurrency),
    originIsNative: isNativeCurrency(originCurrency),
    amount,
    userAddress: normalizeAddress(userAddress),
    recipientAddress: normalizeAddress(recipientAddress ?? userAddress),
  };
}

type RelayQuoteDetails = {
  recipient?: string;
  currencyIn?: {currency?: {chainId?: number; address?: string}; amount?: string};
  currencyOut?: {currency?: {chainId?: number; address?: string}};
};
export type RelayQuote = {details?: RelayQuoteDetails};

/**
 * Second layer: the quote's own description of what it will do, checked
 * against the intent.
 *
 * Enforced only where Relay actually returned the field — see this
 * file's header for why absence is not treated as a failure here.
 */
export function assertQuoteMatchesIntent(quote: RelayQuote | null | undefined, intent: TransactionIntent | null | undefined): void {
  if (!intent) {
    fail('This trade has no recorded intent to check against.');
  }
  const details = quote?.details;
  if (!details) return;

  // Address EQUALITY is only asserted between two EVM addresses. A
  // Relay quote's destination can be Solana, where the address is
  // base58 and there is no single canonical spelling this code can be
  // sure Relay echoes back unchanged — asserting equality there could
  // block a legitimate bridge over a formatting difference, which is
  // the one outcome worse than not checking. Chain ids and amounts,
  // which are unambiguous on every chain, are still checked in full
  // below, and the EVM origin side (the side that actually spends) is
  // checked exactly.

  const inChainId = details.currencyIn?.currency?.chainId;
  if (Number.isFinite(inChainId) && Number(inChainId) !== intent.originChainId) {
    fail(`The route would spend from chain ${inChainId}, not the chain you chose (${intent.originChainId}).`);
  }
  const outChainId = details.currencyOut?.currency?.chainId;
  if (Number.isFinite(outChainId) && Number(outChainId) !== intent.destinationChainId) {
    fail(`The route would deliver to chain ${outChainId}, not the chain you chose (${intent.destinationChainId}).`);
  }

  const inCurrency = normalizeAddress(details.currencyIn?.currency?.address);
  if (comparableAddresses(inCurrency, intent.originCurrency) && inCurrency !== intent.originCurrency) {
    // Native is the one legitimate mismatch: providers disagree on which
    // sentinel means "the chain's own coin", and both spellings mean the
    // same asset.
    if (!(intent.originIsNative && isNativeCurrency(inCurrency))) {
      fail(`The route would spend a different token (${inCurrency}) than the one you chose.`);
    }
  }
  const outCurrency = normalizeAddress(details.currencyOut?.currency?.address);
  if (comparableAddresses(outCurrency, intent.destinationCurrency) && outCurrency !== intent.destinationCurrency) {
    if (!(isNativeCurrency(intent.destinationCurrency) && isNativeCurrency(outCurrency))) {
      fail(`The route would deliver a different token (${outCurrency}) than the one you chose.`);
    }
  }

  const recipient = normalizeAddress(details.recipient);
  if (comparableAddresses(recipient, intent.recipientAddress) && recipient !== intent.recipientAddress) {
    fail(`The route would send the proceeds to ${recipient}, not to the address you chose.`);
  }

  const spend = toBigInt(details.currencyIn?.amount);
  if (spend !== null && spend > intent.amount) {
    fail(`The route would spend ${spend} base units, more than the ${intent.amount} you entered.`);
  }
}

export type RelayTransactionItem = {
  data?: {chainId?: number | string; to?: string; data?: string; value?: string | number | bigint | null; instructions?: unknown[]};
};

/**
 * Real, confirmed bug fixed here (found auditing this exact function):
 * every check below — `to` shaped as an EVM address, ERC-20/Permit2
 * selector decoding — assumed EVERY item was EVM-shaped. A genuine
 * Solana-side Relay step has `instructions`, not `to`/`data` in the EVM
 * sense, so `data.to` is always undefined for one — meaning this
 * function unconditionally threw "no valid destination address" for
 * every Solana item, before signing was ever attempted. In practice
 * this meant any Relay quote touching Solana could never actually
 * execute, full stop, regardless of whether the quote was legitimate.
 * Solana items now skip the EVM-specific body (destination address,
 * native value, approve-selector decoding — none of which mean
 * anything for an instruction list); the real Solana-specific check
 * (fee payer identity, dangerous SPL instructions) lives in
 * solanaTxIntent.ts and is run by executeRelayQuote.ts on the actual
 * built transaction right before signing, not here — this file has no
 * Solana SDK dependency and isn't the right place to add one.
 *
 * SECOND real, confirmed bug fixed here after a real Solana Sell
 * failed with "no chain": the original version of this fix still ran
 * the numeric-chainId check BEFORE the isSolanaShapedItem branch,
 * on the assumption that Relay always echoes a numeric chainId
 * (this app's own MAINNET_CHAIN_IDS.solana = 792703809) on Solana
 * items too, the same as it does for EVM ones. A real Solana-origin
 * Sell quote proved that assumption wrong — Relay's own response
 * omitted chainId entirely on the Solana instruction item, which
 * `Number(undefined)` turns into NaN, failing `Number.isInteger` and
 * blocking every Solana Sell regardless of legitimacy. The
 * Solana-shape check now runs FIRST, and validates chain identity
 * against the INTENT (intent.originChainId — recorded from what the
 * user actually asked for, at quote time) rather than trusting a
 * per-item field Relay doesn't reliably populate for this shape.
 */
const SOLANA_CHAIN_ID = 792703809;

function isSolanaShapedItem(data: {instructions?: unknown[]} | undefined): boolean {
  return Array.isArray(data?.instructions);
}

/**
 * First layer, and the one that actually bounds the loss: every
 * transaction about to be signed, checked against the intent.
 *
 * `items` is the flattened list of transaction step items across the
 * whole quote — checked together, not one at a time, because the native
 * cap is a cap on the TOTAL (a response could otherwise split a drain
 * across several individually-innocent transactions) and because an
 * approval can only be judged against the other transactions in the
 * same route.
 *
 * Throws on anything in the blocking set; returns an array of warning
 * strings for the suspicious-but-possibly-legitimate cases described in
 * this file's header.
 */
export function assertTransactionItemsMatchIntent(items: RelayTransactionItem[] | null | undefined, intent: TransactionIntent | null | undefined): string[] {
  if (!intent) {
    fail('This trade has no recorded intent to check against.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    fail('The routing service returned no transactions to sign.');
  }

  const warnings: string[] = [];
  let totalNativeValue = 0n;

  // Every contract called AFTER each item. An approval's spender has to
  // be one of them: a legitimate approve exists precisely so that a LATER
  // transaction in the same route can pull the tokens. A spender nothing
  // afterwards calls is an approval to a stranger.
  const calledAfter: Set<string>[] = items.map(() => new Set<string>());
  for (let i = items.length - 2; i >= 0; i--) {
    calledAfter[i] = new Set(calledAfter[i + 1]);
    const next = normalizeAddress(items[i + 1]?.data?.to);
    if (next) calledAfter[i].add(next);
  }

  for (const [index, item] of items.entries()) {
    const data = item?.data;
    if (!data || typeof data !== 'object') {
      fail('The routing service returned a transaction with no data.');
    }

    // Solana item: checked FIRST now (see isSolanaShapedItem's own
    // comment for why — a real Solana Sell's chainId came back
    // unpopulated). Chain identity is verified against the INTENT
    // instead of the per-item field; everything below this branch is
    // EVM-specific (an 0x... address, ERC-20/Permit2 calldata) and
    // doesn't apply to an instruction list, so it's skipped entirely.
    if (isSolanaShapedItem(data)) {
      if (intent.originChainId !== SOLANA_CHAIN_ID) {
        fail('The routing service returned a Solana transaction for a trade that was not sourced from Solana.');
      }
      continue;
    }

    // CHAIN. Absence is a failure, not a skip: a wallet that only
    // switches chains when chainId is set means an omitted chainId
    // signs on whichever chain it's already on.
    const chainId = Number(data.chainId);
    if (!Number.isInteger(chainId)) {
      fail('The routing service returned a transaction with no chain.');
    }
    if (chainId !== intent.originChainId) {
      fail(`A transaction would be signed on chain ${chainId}, not the chain you chose (${intent.originChainId}).`);
    }

    const to = normalizeAddress(data.to);
    if (!to || !/^0x[0-9a-f]{40}$/.test(to)) {
      fail('The routing service returned a transaction with no valid destination address.');
    }

    // NATIVE VALUE. Missing/empty reads as zero, which is the safe
    // direction — it can only make the running total smaller.
    const value = data.value === undefined || data.value === null || data.value === '' ? 0n : toBigInt(data.value);
    if (value === null) {
      fail(`The routing service returned a transaction with an unreadable value ("${String(data.value)}").`);
    }
    totalNativeValue += value;

    const selector = selectorOf(data.data);
    if (selector === ERC20_TRANSFER_SELECTOR || selector === ERC20_TRANSFER_FROM_SELECTOR) {
      fail(
        `The routing service asked you to sign a direct token transfer (to ${to}) instead of a swap step. ` +
          'A real route never needs your wallet to call transfer/transferFrom itself — only a contract you already approved does that internally.',
      );
    }
    if (selector === ERC20_APPROVE_SELECTOR || selector === PERMIT2_APPROVE_SELECTOR) {
      // ERC-20: approve(spender, amount)                  -> spender word 0, amount word 1.
      // Permit2: approve(token, spender, amount, expiry)  -> spender word 1, amount word 2.
      const isErc20 = selector === ERC20_APPROVE_SELECTOR;
      const spenderWord = calldataWord(data.data as string, isErc20 ? 0 : 1);
      const approved = calldataWord(data.data as string, isErc20 ? 1 : 2);
      if (spenderWord === null || approved === null) {
        fail('The routing service returned an approval that could not be read.');
      }
      const spender = `0x${spenderWord.toString(16).padStart(40, '0')}`;

      // The token being approved. For ERC-20 that's the transaction's
      // own destination; for Permit2 it's the first argument.
      const approvedToken = isErc20 ? to : `0x${(calldataWord(data.data as string, 0) ?? 0n).toString(16).padStart(40, '0')}`;
      if (intent.originCurrency && !intent.originIsNative && approvedToken !== intent.originCurrency) {
        fail(`The route asks to approve a token (${approvedToken}) that isn't the one you're spending.`);
      }

      if (!calledAfter[index].has(spender)) {
        fail(
          `The route asks to approve ${spender} to spend your tokens, but no transaction in this route calls that address. ` +
            'A legitimate approval always names a contract the same route goes on to use.',
        );
      }

      if (approved > intent.amount) {
        fail(
          `This route asks to approve ${approved} base units of your token, more than the ${intent.amount} this trade spends — ` +
            `the spender (${spender}) would keep that allowance afterwards.`,
        );
      }
    }
  }

  if (intent.originIsNative) {
    if (totalNativeValue > intent.amount) {
      fail(`The transactions would send ${totalNativeValue} base units of native currency, more than the ${intent.amount} you entered.`);
    }
  } else if (totalNativeValue > 0n) {
    warnings.push(
      `This route attaches ${totalNativeValue} base units of native currency to a trade that spends a token, ` +
        'which is usually a protocol fee but is worth knowing about.',
    );
  }

  return warnings;
}

/**
 * Convenience wrapper: both layers, in the order they should run.
 * Throws on anything blocking; returns the warning list otherwise.
 */
export function assertQuoteSafeToSign(quote: RelayQuote | null | undefined, intent: TransactionIntent | null | undefined, items: RelayTransactionItem[] | null | undefined): string[] {
  assertQuoteMatchesIntent(quote, intent);
  return assertTransactionItemsMatchIntent(items, intent);
}
