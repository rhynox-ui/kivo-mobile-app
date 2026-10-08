// Firewall-guarded execution of a Kivo quote through a platform signer.
//
// Mirrors the engine's own executeRelayQuote() discipline step for step:
//   1. the quote must carry the intent getRelayQuote() tagged it with,
//   2. it must be fresh (same 2-minute window),
//   3. only plain EVM "transaction" steps are handled,
//   4. assertQuoteSafeToSign() runs over EVERY pending item before the
//      first one is signed,
//   5. items are sent in order, each confirmed on-chain before the next,
//   6. Relay's status endpoint is polled until the fill settles.
//
// The difference is only WHO signs: the engine's executor signs with a
// raw private key + Relay gasless sponsorship (disabled for Kivo until
// Kivo-owned sponsor infrastructure exists). Here the signer is an
// interface: the browser wallet (web) or the device keychain wallet
// (mobile). Neither implementation ever hands key material to this file.

import type {Address, Hex} from 'viem';
import {publicClientForChainId, viemChainForChainId} from '../core/chainRegistry';
import {intentForQuote, type RelayTransactionStepItem} from '../core/relayQuote';
import {assertQuoteSafeToSign} from '../core/txIntentFirewall';
import {QUOTE_MAX_AGE_MS, type KivoQuote} from './quote';

export type EvmCall = {chainId: number; to: Address; data: Hex; value: bigint};

export type KivoEvmSigner = {
  kind: 'evm-browser' | 'evm-local';
  address: string;
  /** Put the signer on `chainId` or throw. Must never silently stay on another chain. */
  ensureChain(chainId: number): Promise<void>;
  /** Ask the user's wallet to sign and broadcast exactly this call. Returns the tx hash. */
  sendTransaction(call: EvmCall): Promise<Hex>;
};

export type ExecutionStage = 'preflight' | 'switching-network' | 'awaiting-signature' | 'confirming' | 'filling' | 'success' | 'pending' | 'failed' | 'refunded';

export type ExecutionUpdate = {
  stage: ExecutionStage;
  step: number;
  totalSteps: number;
  txHashes: string[];
  requestId: string | null;
  message: string;
};

export type ExecutionResult = {status: 'success' | 'pending' | 'refunded'; txHashes: string[]; requestId: string | null; warnings: string[]; chainIds: number[]};

export class KivoExecutionError extends Error {
  txHashes: string[];
  constructor(message: string, txHashes: string[] = []) {
    super(message);
    this.name = 'KivoExecutionError';
    this.txHashes = txHashes;
  }
}

let RELAY_STATUS_URL = 'https://api.relay.link/intents/status/v3';

/** Web routes status checks through Kivo's same-origin proxy (`/api/relay/status`). */
export function configureRelayStatusUrl(url: string): void {
  RELAY_STATUS_URL = url;
}
const RECEIPT_TIMEOUT_MS = 3 * 60 * 1000;

function isHexAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function toCall(item: RelayTransactionStepItem): EvmCall {
  const data = item.data;
  const chainId = Number(data?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new KivoExecutionError('The route returned a transaction without a network.');
  if (!viemChainForChainId(chainId)) throw new KivoExecutionError(`Kivo has no network configuration for chain ${chainId}.`);
  if (!isHexAddress(data?.to)) throw new KivoExecutionError('The route returned an invalid transaction target.');
  const calldata = data?.data ?? '0x';
  if (typeof calldata !== 'string' || !/^0x[0-9a-fA-F]*$/.test(calldata)) throw new KivoExecutionError('The route returned invalid transaction data.');
  let value = 0n;
  try { value = data?.value ? BigInt(data.value) : 0n; } catch { throw new KivoExecutionError('The route returned an invalid transaction value.'); }
  return {chainId, to: data.to as Address, data: calldata as Hex, value};
}

export function explorerTxUrl(chainId: number, hash: string): string | null {
  const base = viemChainForChainId(chainId)?.blockExplorers?.default?.url;
  return base ? `${base.replace(/\/$/, '')}/tx/${hash}` : null;
}

export function relayRequestUrl(requestId: string): string {
  return `https://relay.link/transaction/${requestId}`;
}

export type RelayStatus = 'waiting' | 'pending' | 'delayed' | 'success' | 'failure' | 'refund' | 'unknown';

export async function fetchRelayStatus(requestId: string): Promise<RelayStatus> {
  try {
    const res = await fetch(`${RELAY_STATUS_URL}?requestId=${encodeURIComponent(requestId)}`);
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as {status?: string};
    const status = body?.status;
    return status === 'waiting' || status === 'pending' || status === 'delayed' || status === 'success' || status === 'failure' || status === 'refund' ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Every pre-sign check, with nothing signed. Throws on any problem; returns firewall warnings and the ordered calls. */
export function preflightKivoQuote(kq: KivoQuote, signerAddress: string, now = Date.now(), options: {allowSolana?: boolean} = {}): {calls: EvmCall[]; warnings: string[]; requestId: string | null} {
  const tagged = intentForQuote(kq.quote);
  if (!tagged) throw new KivoExecutionError('This quote has no recorded intent to check against — refusing to sign.');
  if (now - tagged.quotedAt > QUOTE_MAX_AGE_MS) throw new KivoExecutionError('This quote has expired. Refresh it before signing.');
  if (kq.view.unsupportedReason) throw new KivoExecutionError(kq.view.unsupportedReason);
  if (!tagged.intent.userAddress || tagged.intent.userAddress !== signerAddress.trim().toLowerCase()) {
    throw new KivoExecutionError('The connected wallet changed since this quote was requested. Refresh the quote.');
  }
  const pending: RelayTransactionStepItem[] = [];
  let requestId: string | null = null;
  for (const step of kq.quote.steps ?? []) {
    if (step.kind !== 'transaction') throw new KivoExecutionError(`Unsupported route step "${step.kind}".`);
    requestId = requestId ?? step.requestId ?? null;
    for (const item of step.items ?? []) if (item.status !== 'complete') pending.push(item);
  }
  if (pending.length === 0) throw new KivoExecutionError('The route returned no transactions to sign.');
  if (!options.allowSolana && pending.some(item => item.data?.instructions)) throw new KivoExecutionError('This route includes a Solana transaction. Kivo currently signs EVM transactions only.');
  const warnings = assertQuoteSafeToSign(kq.quote, tagged.intent, pending);
  // Solana-shaped items are signed separately (deviceExecute.ts); only EVM items become calls.
  return {calls: pending.filter(item => !item.data?.instructions).map(toCall), warnings, requestId};
}

export async function executeKivoQuote(
  kq: KivoQuote,
  signer: KivoEvmSigner,
  onUpdate: (update: ExecutionUpdate) => void = () => {},
  options: {statusTimeoutMs?: number; pollIntervalMs?: number} = {},
): Promise<ExecutionResult> {
  const txHashes: string[] = [];
  const emit = (stage: ExecutionStage, step: number, total: number, requestId: string | null, message: string) =>
    onUpdate({stage, step, totalSteps: total, txHashes: [...txHashes], requestId, message});

  emit('preflight', 0, 0, null, 'Checking the route against your trade before anything is signed…');
  const {calls, warnings, requestId} = preflightKivoQuote(kq, signer.address);
  const total = calls.length;

  // Simulate the first call so an obviously failing transaction (no gas,
  // insufficient token balance) is caught before the wallet prompt.
  // Later calls can depend on earlier ones (approve -> deposit), so only
  // the first is meaningful to simulate up front.
  try {
    await publicClientForChainId(calls[0].chainId).estimateGas({account: signer.address as Address, to: calls[0].to, data: calls[0].data, value: calls[0].value});
  } catch (error) {
    const detail = error instanceof Error ? (error as {shortMessage?: string}).shortMessage ?? error.message : String(error);
    throw new KivoExecutionError(/insufficient funds/i.test(detail)
      ? 'Not enough native balance to pay network gas for this transaction.'
      : `The network rejected a simulation of this trade, so nothing was signed: ${detail}`);
  }

  try {
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      emit('switching-network', index + 1, total, requestId, `Confirming your wallet is on the right network (${viemChainForChainId(call.chainId)?.name ?? call.chainId})…`);
      await signer.ensureChain(call.chainId);
      emit('awaiting-signature', index + 1, total, requestId, total > 1 ? `Approve transaction ${index + 1} of ${total} in your wallet.` : 'Approve the transaction in your wallet.');
      const hash = await signer.sendTransaction(call);
      txHashes.push(hash);
      emit('confirming', index + 1, total, requestId, 'Transaction submitted. Waiting for on-chain confirmation…');
      const receipt = await publicClientForChainId(call.chainId).waitForTransactionReceipt({hash, timeout: RECEIPT_TIMEOUT_MS});
      if (receipt.status !== 'success') throw new KivoExecutionError('The transaction reverted on-chain. No further steps were sent.', txHashes);
    }
  } catch (error) {
    if (error instanceof KivoExecutionError) { error.txHashes = [...txHashes]; throw error; }
    const message = error instanceof Error ? error.message : String(error);
    const rejected = /user rejected|user denied|rejected the request|cancel/i.test(message);
    throw new KivoExecutionError(rejected ? 'You rejected the request in your wallet. Nothing further was sent.' : message, txHashes);
  }

  const chainIds = Array.from(new Set(calls.map(call => call.chainId)));
  if (!requestId) {
    emit('success', total, total, null, 'Trade confirmed on-chain.');
    return {status: 'success', txHashes, requestId, warnings, chainIds};
  }

  const deadline = Date.now() + (options.statusTimeoutMs ?? 10 * 60 * 1000);
  const interval = options.pollIntervalMs ?? 2500;
  emit('filling', total, total, requestId, 'Waiting for the route to settle…');
  while (Date.now() < deadline) {
    const status = await fetchRelayStatus(requestId);
    if (status === 'success') {
      emit('success', total, total, requestId, 'Trade complete.');
      return {status: 'success', txHashes, requestId, warnings, chainIds};
    }
    if (status === 'refund') {
      emit('refunded', total, total, requestId, 'The route could not be filled and your funds were refunded.');
      return {status: 'refunded', txHashes, requestId, warnings, chainIds};
    }
    if (status === 'failure') throw new KivoExecutionError('The routing service reported this trade failed after submission. Check the transaction details before retrying.', txHashes);
    await new Promise<void>(resolve => setTimeout(() => resolve(), interval));
  }
  emit('pending', total, total, requestId, 'Your transaction is on-chain but the route is still settling. Check its status before retrying.');
  return {status: 'pending', txHashes, requestId, warnings, chainIds};
}
