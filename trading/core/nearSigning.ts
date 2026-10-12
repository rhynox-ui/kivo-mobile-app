// src/core/nearSigning.ts
//
// Signs and sends NEAR actions from the wallet's own NEAR account
// (keys.ts, m/44'/397'/0'), with Mango paying the gas through mango-api's
// NEAR relayer (near-relayer.js) — NEAR's own meta-transactions, NEP-366:
// this app signs a DelegateAction with the user's key, the relayer wraps
// it and pays gas. The user's signature is the only thing that authorizes
// what happens; the relayer can't change it. Built on NEAR's official
// @near-js/transactions + @near-js/crypto (the same library the relayer
// verifies with).
//
// Calls use the same shape as the site's NEAR code (near-connect's
// `{receiverId, actions: [{type: 'FunctionCall', params}]}`), so routes
// built by the site's tested intearRouter / 1Click code plug in unchanged.
//
// Only gas is sponsored: NEAR attached to an action (storage deposits,
// 1 yocto) comes from the user's own NEAR balance. A brand-new account
// gets that starter NEAR from the relayer's bootstrap once it holds USDC.

import {KeyPair} from '@near-js/crypto';
import {actionCreators, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, Signature} from '@near-js/transactions';
import {nearRpc} from './nearRpc.ts';
import {ONE_CLICK_PROXY_BASE_URL} from './oneClick.ts';
import type {DerivedAccounts} from '../wallet/keys';

export const NEAR_RELAY_URL = `${ONE_CLICK_PROXY_BASE_URL}/relay`;
export const NEAR_BOOTSTRAP_URL = `${ONE_CLICK_PROXY_BASE_URL}/relay/bootstrap`;
/** How long a signed action stays valid, in NEAR blocks (~1s each) — inside the relayer's own 300-block limit. */
export const DELEGATE_TTL_BLOCKS = 200n;

export type NearFunctionCall = {type: 'FunctionCall'; params: {methodName: string; args: Record<string, unknown>; gas: string; deposit: string}};
export type NearCall = {receiverId: string; actions: NearFunctionCall[]};
/**
 * What Mango's relayer returns per call: its own transaction's hash and
 * status (which only says the relay was accepted), and `result` — the
 * final status of the user's own call ({SuccessValue} / {Failure}, null
 * when NEAR's outcome didn't say).
 */
export type NearRelayOutcome = {hash: string; status: unknown; result?: {SuccessValue?: string; Failure?: unknown} | null};

export class NearSendError extends Error {
  /** Outcomes of the calls that already went through before this one failed. */
  sent: NearRelayOutcome[];
  constructor(message: string, sent: NearRelayOutcome[] = []) {
    super(message);
    this.sent = sent;
  }
}

type Rpc = typeof nearRpc;

function nearKeyPair(session: DerivedAccounts): {accountId: string; keyPair: KeyPair} {
  if (!session.near?.privateKey) throw new NearSendError('This wallet has no NEAR account.');
  return {accountId: session.near.address, keyPair: KeyPair.fromString(session.near.privateKey as `ed25519:${string}`)};
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function isUnknownAccount(err: unknown): boolean {
  const e = err as {nearError?: unknown; message?: string};
  return /UNKNOWN_ACCOUNT/.test(JSON.stringify(e?.nearError ?? e?.message ?? ''));
}

export async function nearAccountExists(accountId: string, rpc: Rpc = nearRpc): Promise<boolean> {
  try {
    await rpc('query', {request_type: 'view_account', finality: 'final', account_id: accountId});
    return true;
  } catch (err) {
    if (isUnknownAccount(err)) return false;
    throw err;
  }
}

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const data = (await res.json().catch(() => ({}))) as {data?: unknown; error?: string};
  if (!res.ok || data?.error) throw new Error(data?.error || `Mango's NEAR relay answered ${res.status}.`);
  return data.data;
}

/**
 * Makes sure the wallet's NEAR account exists on-chain (an implicit account
 * only exists once it holds NEAR). A new one is set up by Mango's relayer
 * once USDC has landed in it.
 */
export async function ensureNearAccount(
  session: DerivedAccounts,
  {rpc = nearRpc, fetchImpl = fetch, waitMs = 1500, tries = 8}: {rpc?: Rpc; fetchImpl?: typeof fetch; waitMs?: number; tries?: number} = {},
): Promise<{created: boolean}> {
  const {accountId} = nearKeyPair(session);
  if (await nearAccountExists(accountId, rpc)) return {created: false};
  await postJson(NEAR_BOOTSTRAP_URL, {accountId}, fetchImpl);
  for (let i = 0; i < tries; i++) {
    if (await nearAccountExists(accountId, rpc)) return {created: true};
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw new NearSendError('Your NEAR account is still being set up — try again in a moment.');
}

function toActions(call: NearCall) {
  if (!Array.isArray(call.actions) || call.actions.length === 0) throw new NearSendError('Nothing to send.');
  return call.actions.map(a => {
    if (a?.type !== 'FunctionCall') throw new NearSendError('Only contract calls can be sent with Mango covering gas.');
    const {methodName, args, gas, deposit} = a.params;
    return actionCreators.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
  });
}

/**
 * Signs each call as a NEP-366 DelegateAction from the wallet's NEAR
 * account (consecutive nonces, valid for DELEGATE_TTL_BLOCKS). Returns the
 * base64 SignedDelegates the relayer accepts, in order.
 */
export async function signNearDelegates(session: DerivedAccounts, calls: NearCall[], {rpc = nearRpc}: {rpc?: Rpc} = {}): Promise<string[]> {
  const {accountId, keyPair} = nearKeyPair(session);
  const publicKey = keyPair.getPublicKey();
  const [accessKey, block] = await Promise.all([
    rpc<{nonce: number | string}>('query', {request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey.toString()}),
    rpc<{header: {height: number | string}}>('block', {finality: 'final'}),
  ]);
  const baseNonce = BigInt(accessKey.nonce);
  const maxBlockHeight = BigInt(block.header.height) + DELEGATE_TTL_BLOCKS;
  return calls.map((call, i) => {
    const delegateAction = buildDelegateAction({
      senderId: accountId,
      receiverId: call.receiverId,
      actions: toActions(call),
      nonce: baseNonce + 1n + BigInt(i),
      maxBlockHeight,
      publicKey,
    });
    const {signature} = keyPair.sign(encodeDelegateAction(delegateAction));
    return toBase64(encodeSignedDelegate({delegateAction, signature: new Signature({keyType: publicKey.keyType, data: signature})}));
  });
}

/**
 * Sends the calls in order through Mango's relayer (Mango pays the gas),
 * each only after the previous one went through. Sets up a new account
 * first when needed. Throws NearSendError on the first failure, carrying
 * what was already sent.
 */
export async function sendSponsoredNearCalls(
  session: DerivedAccounts,
  calls: NearCall[],
  {rpc = nearRpc, fetchImpl = fetch}: {rpc?: Rpc; fetchImpl?: typeof fetch} = {},
): Promise<NearRelayOutcome[]> {
  await ensureNearAccount(session, {rpc, fetchImpl});
  const signed = await signNearDelegates(session, calls, {rpc});
  const outcomes: NearRelayOutcome[] = [];
  for (const signedDelegate of signed) {
    try {
      outcomes.push(await postJson(NEAR_RELAY_URL, {signedDelegate}, fetchImpl));
    } catch (err) {
      throw new NearSendError(err instanceof Error ? err.message : 'Mango could not send this NEAR transaction.', outcomes);
    }
  }
  return outcomes;
}
