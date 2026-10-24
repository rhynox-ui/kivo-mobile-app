// Whether a failed transfer may already be on-chain. Once a signed
// transaction or Relay batch may have reached the network, the app must never
// say "nothing was sent" or offer a plain retry: that is how a withdrawal gets
// sent twice. Errors carry the signature / Relay requestId so the UI can link
// to it and re-check its status instead.

const MAYBE_BROADCAST_KEY = 'kivoMaybeBroadcast';
const PARTIAL_TX_HASHES_KEY = 'kivoPartialTxHashes';

export type BroadcastEvidence = {signature?: string; requestId?: string};

/** Marks `error` as raised after a transaction may have been broadcast, keeping its message. */
export function markMaybeBroadcast(error: unknown, evidence: BroadcastEvidence): Error {
  const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const target = err as Error & Record<string, unknown>;
  target[MAYBE_BROADCAST_KEY] = true;
  if (evidence.signature && !target.signature) target.signature = evidence.signature;
  if (evidence.requestId && !target.requestId) target.requestId = evidence.requestId;
  return err;
}

/** A transaction that landed on-chain and failed there: its tokens did not move. */
export function markFailedOnChain(error: unknown, evidence: BroadcastEvidence): Error {
  const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const target = err as Error & Record<string, unknown>;
  target.kivoFailedOnChain = true;
  if (evidence.signature && !target.signature) target.signature = evidence.signature;
  if (evidence.requestId && !target.requestId) target.requestId = evidence.requestId;
  return err;
}

export type TransferErrorState =
  /** Nothing was signed or broadcast; retrying is safe. */
  | {state: 'not-sent'; message: string}
  /** Landed and failed on-chain: funds did not move, a link is available. */
  | {state: 'failed-on-chain'; message: string; signature?: string; requestId?: string}
  /** May be on-chain (or still settling): show pending, never "nothing was sent", no plain retry. */
  | {state: 'maybe-sent'; message: string; signature?: string; requestId?: string; txHashes: string[]};

/** How the UI must present a transfer/withdrawal error. */
export function classifyTransferError(error: unknown): TransferErrorState {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Transfer failed.';
  if (!error || typeof error !== 'object') return {state: 'not-sent', message};
  const record = error as Record<string, unknown>;
  const signature = typeof record.signature === 'string' ? record.signature : undefined;
  const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
  const partial = Array.isArray(record[PARTIAL_TX_HASHES_KEY]) ? (record[PARTIAL_TX_HASHES_KEY] as unknown[]).filter((h): h is string => typeof h === 'string') : [];
  const pendingRelay = (error as {name?: unknown}).name === 'RelayGaslessPendingError';
  const failedOnChain = record.kivoFailedOnChain === true || Boolean(signature && /failed on-chain/i.test(message));
  // A signature on the error means a signed transaction existed and may have been submitted.
  if (record[MAYBE_BROADCAST_KEY] === true || pendingRelay || partial.length > 0 || (signature && !failedOnChain)) {
    return {state: 'maybe-sent', message, signature, requestId, txHashes: partial.length ? partial : signature ? [signature] : []};
  }
  if (failedOnChain) {
    return {state: 'failed-on-chain', message, signature, requestId};
  }
  return {state: 'not-sent', message};
}

/**
 * Whether an error from submitting a signed Solana transaction proves it never
 * reached the network (a preflight rejection). Anything else is ambiguous.
 */
export function solanaSubmitDefinitelyRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/already been processed/i.test(message)) return false;
  return /simulation failed|blockhash not found|preflight|insufficient (lamports|funds)|no record of a prior credit|AccountNotFound|InsufficientFundsFor(Fee|Rent)|signature verification fail/i.test(message);
}
