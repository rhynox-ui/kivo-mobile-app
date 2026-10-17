// Top holders of a Solana token straight from the network, for tokens GoPlus
// hasn't indexed yet (new launches, pump.fun). Only called when the user opens
// the holders sheet, and cached, so it costs no RPC calls otherwise.

import type {TokenHolder} from '../core/goplusTokenSecurity';
import {SOLANA_READ_RPCS} from './balances';

const TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;
const cache = new Map<string, {at: number; value: Promise<TokenHolder[]>}>();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown = null;
  for (const url of SOLANA_READ_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: controller.signal});
      const body = await response.json() as {result?: T; error?: {message?: string}};
      if (response.ok && body.result !== undefined) return body.result;
      lastError = new Error(body.error?.message ?? `RPC ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Solana RPC unavailable.');
}

async function load(mint: string): Promise<TokenHolder[]> {
  const [largest, supply] = await Promise.all([
    rpc<{value: {address: string; amount: string}[]}>('getTokenLargestAccounts', [mint, {commitment: 'confirmed'}]),
    rpc<{value: {amount: string}}>('getTokenSupply', [mint, {commitment: 'confirmed'}]),
  ]);
  const total = BigInt(supply.value.amount || '0');
  const top = largest.value.filter(row => BigInt(row.amount || '0') > 0n).slice(0, 10);
  if (!top.length) return [];
  // The largest accounts are token accounts: show the wallet that owns each.
  const owners = await rpc<{value: ({data?: {parsed?: {info?: {owner?: string}}}} | null)[]}>('getMultipleAccounts', [top.map(row => row.address), {encoding: 'jsonParsed', commitment: 'confirmed'}])
    .then(result => result.value.map(account => account?.data?.parsed?.info?.owner ?? null))
    .catch(() => top.map(() => null));
  return top.map((row, index) => ({
    address: owners[index] ?? row.address,
    percent: total > 0n ? Number((BigInt(row.amount) * 1_000_000n) / total) / 10_000 : null,
    isLocked: false,
    isContract: false,
    tag: null,
  }));
}

/** Top 10 holders (owner wallets) with their share of supply. Throws when every RPC fails. */
export function fetchSolanaTopHolders(mint: string): Promise<TokenHolder[]> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load(mint);
  cache.set(mint, {at: Date.now(), value});
  value.catch(() => { if (cache.get(mint)?.value === value) cache.delete(mint); });
  return value;
}
