// Gasless execution of a Kivo quote (mobile). Same model as Mango Pro:
//
//   - the device wallet holds the key (no external wallet, no "connect"),
//   - the user only needs USDC: Relay submits the trade and Kivo's Relay app
//     balance pays the network gas,
//   - the EOA is delegated to Uniswap's Calibur batch executor via EIP-7702,
//     so approve + deposit run as ONE atomic call signed off-chain,
//   - Kivo's backend (/api/relay/execute) adds the Relay API key. The key
//     never ships in the app.
//
// Safety is identical to the wallet path in execute.ts: the same
// preflightKivoQuote() runs the intent firewall over every pending item
// before anything is signed. There is deliberately NO fallback to a normal
// gas-paying transaction: a user holding only USDC would be stranded, and a
// silent switch changes what the user agreed to.

import type {Address} from 'viem';
import type {LocalAccount} from 'viem/accounts';
import {viemChainForChainId} from '../core/chainRegistry';
import {preflightRelayGaslessEvm, sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {KivoExecutionError, preflightKivoQuote, type ExecutionResult, type ExecutionUpdate, type EvmCall} from './execute';
import type {KivoQuote} from './quote';

export type GaslessStatus = {available: boolean; reason: string | null};

let statusUrl = '';
let cached: {value: GaslessStatus; at: number} | null = null;

/** Points the client at Kivo's backend (`<base>/api/relay/config`). */
export function configureGaslessStatusUrl(url: string): void {
  statusUrl = url;
  cached = null;
}

/** Asks Kivo's backend whether gas sponsorship is switched on (a Relay API key with a funded balance is configured). */
export async function fetchGaslessStatus(force = false): Promise<GaslessStatus> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.value;
  if (!statusUrl) return {available: false, reason: 'Gasless trading is not configured in this build.'};
  let value: GaslessStatus;
  try {
    const res = await fetch(statusUrl);
    const body = (await res.json().catch(() => ({}))) as {gasless?: boolean; reason?: string};
    value = res.ok && body.gasless
      ? {available: true, reason: null}
      : {available: false, reason: body.reason ?? 'Gasless trading is not switched on yet.'};
  } catch {
    value = {available: false, reason: 'Could not reach Kivo to check gasless trading. Check your connection.'};
  }
  cached = {value, at: Date.now()};
  return value;
}

function groupByChain(calls: EvmCall[]): {chainId: number; calls: EvmCall[]}[] {
  const groups: {chainId: number; calls: EvmCall[]}[] = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && last.chainId === call.chainId) last.calls.push(call);
    else groups.push({chainId: call.chainId, calls: [call]});
  }
  return groups;
}

/** Every check that can fail before a signature prompt, with nothing signed. */
export async function preflightGaslessQuote(kq: KivoQuote, account: LocalAccount): Promise<{warnings: string[]}> {
  const {calls, warnings} = preflightKivoQuote(kq, account.address);
  for (const group of groupByChain(calls)) {
    const chain = viemChainForChainId(group.chainId);
    if (!chain) throw new KivoExecutionError(`Kivo has no network configuration for chain ${group.chainId}.`);
    await preflightRelayGaslessEvm({chain, fromAddress: account.address as Address, account});
  }
  return {warnings};
}

export async function executeKivoQuoteGasless(
  kq: KivoQuote,
  account: LocalAccount,
  onUpdate: (update: ExecutionUpdate) => void = () => {},
): Promise<ExecutionResult> {
  const txHashes: string[] = [];
  let requestId: string | null = null;
  const emit = (stage: ExecutionUpdate['stage'], step: number, total: number, message: string) =>
    onUpdate({stage, step, totalSteps: total, txHashes: [...txHashes], requestId, message});

  emit('preflight', 0, 0, 'Checking the route against your trade before anything is signed…');
  // Preflight every chain before signing the first leg. Unified buys can
  // span multiple chains; discovering an unsupported Calibur/EIP-7702 chain
  // after leg 1 has already settled would leave the user partially filled.
  const {warnings} = await preflightGaslessQuote(kq, account);
  const {calls, requestId: quotedRequestId} = preflightKivoQuote(kq, account.address);
  requestId = quotedRequestId;
  const groups = groupByChain(calls);
  const total = groups.length;

  try {
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const chain = viemChainForChainId(group.chainId);
      if (!chain) throw new KivoExecutionError(`Kivo has no network configuration for chain ${group.chainId}.`);
      emit('awaiting-signature', index + 1, total, 'Signing on this device. Kivo covers the network fee.');
      const result = await sendEvmCallsViaRelayGasless({
        chain,
        fromAddress: account.address as Address,
        account,
        calls: group.calls.map(call => ({to: call.to, value: call.value, data: call.data})),
        ...(requestId ? {requestId} : {}),
        onSubmitted: id => { requestId = requestId ?? id; emit('filling', index + 1, total, 'Submitted. Waiting for the route to settle…'); },
      });
      txHashes.push(result.hash);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/refund/i.test(message)) {
      emit('refunded', total, total, 'The route could not be filled and your funds were refunded.');
      return {status: 'refunded', txHashes, requestId, warnings, chainIds: groups.map(g => g.chainId)};
    }
    if (/timed out after submission/i.test(message)) {
      emit('pending', total, total, 'Submitted, but the route is still settling. Check its status before retrying.');
      return {status: 'pending', txHashes, requestId, warnings, chainIds: groups.map(g => g.chainId)};
    }
    throw new KivoExecutionError(message, txHashes);
  }

  emit('success', total, total, 'Trade complete.');
  return {status: 'success', txHashes, requestId, warnings, chainIds: groups.map(g => g.chainId)};
}
