// src/core/tradeErrors.ts
//
// Ported (typed) from mango-mobile's own src/launchpad/tradeErrors.js —
// turns a thrown trade error into one sentence a person can act on.
//
// This exists because TokenTradeScreen used to render `err.message`
// straight onto the screen, and viem's message is a full diagnostic
// dump: the reason, then the from/to/value, then the entire calldata as
// one unbroken hex string, then the decoded call, then a docs link and a
// version banner. A real user hit this on a live trade (an EIP-7702
// sponsored UserOperation rejected by Pimlico's bundler with "Invalid
// fields set on User Operation") and saw several hundred characters of
// hex where an explanation should have been.
//
// The dump is not useless — it is exactly what you want when filing a
// bug — so it is returned as `detail` rather than thrown away. What
// changes is which of the two is the headline.
//
// Deliberately matched on the node's/bundler's own wording rather than
// on error classes: these strings come from the RPC (geth and its
// forks) or the ERC-4337 bundler, so they survive viem/permissionless
// upgrades that reshape the error hierarchy.

const PATTERNS: Array<{match: RegExp; message: string}> = [
  {
    match: /gas required exceeds allowance/i,
    message: 'Not enough native balance left to pay for gas. Lower the amount — the trade needs to leave enough behind to cover the transaction fee.',
  },
  {
    match: /insufficient funds/i,
    message: 'Not enough native balance in this wallet for the amount plus the transaction fee.',
  },
  {
    match: /user rejected|user denied|rejected the request/i,
    message: 'Trade cancelled.',
  },
  {
    match: /deadline|expired/i,
    message: 'The trade took too long to confirm and expired. Try again.',
  },
  {
    match: /slippage|too little received|amountoutmin|price impact/i,
    message: 'The price moved more than the slippage tolerance allowed. Raise the slippage or try a smaller amount.',
  },
  {
    match: /nonce/i,
    message: 'Another transaction from this wallet is still pending. Wait for it to confirm, then try again.',
  },
  {
    match: /replacement transaction underpriced/i,
    message: 'A pending transaction from this wallet is blocking this one. Wait for it to confirm, then try again.',
  },
  {
    match: /invalid fields set on user operation|invalid useroperation|aa[0-9]{2}\b/i,
    message: 'The gasless trading route rejected this transaction. Try again with gasless trading off in Security settings.',
  },
];

function firstLine(text: string): string {
  const line = String(text)
    .split('\n')
    .find(l => l.trim().length > 0);
  return line ? line.trim() : '';
}

/**
 * `message` is safe to show as the headline; `detail` is the original
 * text, for a collapsed "details" affordance or a bug report. `detail`
 * is empty when it would only repeat `message`.
 */
export function describeTradeError(err: unknown): {message: string; detail: string} {
  const raw = (err && typeof err === 'object' && typeof (err as {message?: unknown}).message === 'string' ? (err as {message: string}).message : String(err ?? '')) || '';
  // viem's own one-line summary, when present, is already far closer to
  // readable than the full dump — worth preferring over `message` for
  // the detail text so the hex blob is not the first thing in it.
  const short = err && typeof err === 'object' && typeof (err as {shortMessage?: unknown}).shortMessage === 'string' ? (err as {shortMessage: string}).shortMessage : '';

  for (const {match, message} of PATTERNS) {
    if (match.test(raw)) {
      return {message, detail: short || firstLine(raw)};
    }
  }
  // Unrecognized: fall back to viem's short message if it has one, and
  // only then to the first line of the dump — never the whole thing.
  return {message: short || firstLine(raw) || 'The trade could not be completed.', detail: ''};
}
