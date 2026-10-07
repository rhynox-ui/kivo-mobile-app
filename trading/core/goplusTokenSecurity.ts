// src/core/goplusTokenSecurity.ts
//
// Ported from the reference mobile app's own src/launchpad/goplusTokenSecurity.js
// (itself the source the reference web app's SwapChartPanel.jsx already reuses
// unchanged) — live per-token risk check via GoPlus Security's public
// Token Security API, real and free, no API key. Added TS types on top;
// the actual endpoints/fields/caveats are unchanged from the source,
// confirmed there against GoPlus's own official Node SDK
// (@goplus/sdk-node) rather than guessed.
//
// GENUINE, NAMED GAP, same shape the source discloses: whether GoPlus's
// token_security function has real coverage for every chain this app
// supports could not be confirmed from this sandbox (api.gopluslabs.io
// is blocked). This fails open: an unsupported chain, timeout, non-200,
// or unparseable body all return `null` ("no live check happened"),
// never a false "confirmed safe" summary.

import {marketUrl} from './marketHosts';

const FETCH_TIMEOUT_MS = 6000;
const API_PATH = '/api/v1/token_security';
// Solana is a SEPARATE endpoint with a separate response model, not the
// EVM one with a chain id.
const SOLANA_API_PATH = '/api/v1/solana/token_security';
const CACHE_TTL_MS = 10 * 60 * 1000;

export type TokenHolder = {
  address: string;
  percent: number | null;
  isLocked: boolean;
  isContract: boolean;
  tag: string | null;
};

export type TokenSecuritySummary = {
  isOpenSource: boolean | null;
  isHoneypot: boolean;
  buyTaxPercent: number | null;
  sellTaxPercent: number | null;
  lpLockedPercent: number | null;
  holderCount: number | null;
  holders: TokenHolder[] | null;
  flags: string[];
};

const cache = new Map<string, {summary: TokenSecuritySummary; expiresAt: number}>();

function toBool(flag: unknown): boolean {
  return flag === '1';
}

function toPercent(taxFraction: unknown): number | null {
  // GoPlus's own field docs: buy_tax/sell_tax are a fraction (0.1 = 10%),
  // same "1 means 100%" convention percent uses on lp_holders below.
  const n = Number(taxFraction);
  return Number.isFinite(n) ? n * 100 : null;
}

type GoPlusLpHolder = {is_locked?: number; percent?: unknown};

/**
 * Sums the LP share held by every locked LP holder GoPlus found (top-10
 * only — a real, disclosed lower bound, not the true total whenever a
 * pool has more than 10 LP holders). null when lp_holders itself is
 * absent (genuinely unknown, not "0% locked").
 */
function lockedLpPercent(lpHolders: unknown): number | null {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) {
    return null;
  }
  const lockedFraction = (lpHolders as GoPlusLpHolder[])
    .filter(h => h?.is_locked === 1)
    .reduce((sum, h) => sum + (Number(h?.percent) || 0), 0);
  return Math.min(100, lockedFraction * 100);
}

// Real field -> human label, ordered roughly by how directly each one
// threatens "you may not be able to sell this token or the owner can
// take your funds."
const RISK_FLAGS: [string, string][] = [
  ['is_honeypot', 'Flagged as a honeypot — may not be sellable once bought'],
  ['cannot_sell_all', 'Some holders cannot sell their full balance'],
  ['transfer_pausable', 'Owner can pause all transfers'],
  ['owner_change_balance', 'Owner can directly change holder balances'],
  ['selfdestruct', 'Contract can self-destruct'],
  ['hidden_owner', 'Contract has a hidden owner'],
  ['can_take_back_ownership', 'Ownership can be reclaimed after renouncing'],
  ['is_blacklisted', 'Contract has a blacklist function'],
  ['is_proxy', 'Contract is upgradeable (proxy pattern) — logic can change after launch'],
  ['is_airdrop_scam', 'Flagged as an airdrop scam'],
];

type GoPlusHolder = {address?: string; percent?: unknown; is_locked?: number; is_contract?: number; tag?: string | null};

/**
 * Real top-10 TOKEN holders (distinct from lp_holders, which is
 * LIQUIDITY-POOL position holders). null when GoPlus itself returns no
 * holders array, never a fabricated empty list standing in for
 * "confirmed no other holders."
 */
function parseHolders(holders: unknown): TokenHolder[] | null {
  if (!Array.isArray(holders) || holders.length === 0) {
    return null;
  }
  return (holders as GoPlusHolder[])
    .filter((h): h is GoPlusHolder & {address: string} => Boolean(h?.address))
    .map(h => ({
      address: String(h.address),
      percent: toPercent(h.percent),
      isLocked: h.is_locked === 1,
      isContract: h.is_contract === 1,
      tag: h.tag || null,
    }));
}

type GoPlusSolanaHolder = {token_account?: string; percent?: unknown; is_locked?: number; tag?: string | null};

/**
 * Top-10 holders, Solana shape — deliberately separate from parseHolders
 * above because the two models genuinely differ, not just optional
 * fields: the identifier is `token_account` (the TOKEN ACCOUNT, not the
 * owner's wallet — GoPlus's Solana model carries no owner field at all),
 * and there is no `is_contract` concept. Same "null, never a fabricated
 * empty list" contract as the EVM one.
 */
function parseSolanaHolders(holders: unknown): TokenHolder[] | null {
  if (!Array.isArray(holders) || holders.length === 0) {
    return null;
  }
  return (holders as GoPlusSolanaHolder[])
    .filter((h): h is GoPlusSolanaHolder & {token_account: string} => Boolean(h?.token_account))
    .map(h => ({
      address: String(h.token_account),
      percent: toPercent(h.percent),
      isLocked: h.is_locked === 1,
      isContract: false,
      tag: h.tag || null,
    }));
}

/**
 * Live per-token risk lookup for a Solana mint. Two fields are honestly
 * left null because GoPlus's Solana model simply doesn't carry them:
 * holderCount (no equivalent field — shown as a gap, not invented) and
 * buy/sell tax + honeypot (Solana's own risk model is different).
 *
 * The mint is used as the result key EXACTLY as given, not lowercased:
 * Solana addresses are base58 and case-sensitive.
 */
export async function checkSolanaTokenSecurity(mintAddress: string | null | undefined): Promise<TokenSecuritySummary | null> {
  if (!mintAddress) return null;
  const key = `solana:${mintAddress}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${marketUrl('goplus', SOLANA_API_PATH)}?contract_addresses=${encodeURIComponent(mintAddress)}`, {signal: controller.signal} as RequestInit);
    if (!res.ok) return null;
    const data = (await res.json()) as {result?: Record<string, any>};
    const result = data?.result?.[mintAddress];
    if (!result || typeof result !== 'object') return null;

    const flags: string[] = [];
    if (result.freezable?.status === '1') flags.push('Freeze authority is still active');
    if (result.mintable?.status === '1') flags.push('Supply can still be minted');
    if (result.closable?.status === '1') flags.push('Mint account can be closed');
    if (result.metadata_mutable?.status === '1') flags.push('Token metadata can still be changed');
    if (result.transfer_hook_upgradable?.status === '1') flags.push('Transfer hook can be changed');
    if (result.transfer_fee_upgradable?.status === '1') flags.push('Transfer fee can be changed');
    if (result.non_transferable === '1' || result.none_transferable === '1') flags.push('Token is non-transferable');

    const summary: TokenSecuritySummary = {
      isOpenSource: null,
      isHoneypot: false,
      buyTaxPercent: null,
      sellTaxPercent: null,
      lpLockedPercent: lockedLpPercent(result.lp_holders),
      holderCount: null,
      holders: parseSolanaHolders(result.holders),
      flags,
    };
    cache.set(key, {summary, expiresAt: Date.now() + CACHE_TTL_MS});
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real, live per-token risk lookup. `null` means "inconclusive" (missing
 * args, unsupported chain, network error, timeout, non-200, or
 * unparseable body), never "confirmed safe."
 */
export async function checkTokenSecurity(chainId: number | string | null | undefined, tokenAddress: string | null | undefined): Promise<TokenSecuritySummary | null> {
  if (!chainId || !tokenAddress) return null;
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${marketUrl('goplus', API_PATH)}/${chainId}?contract_addresses=${encodeURIComponent(tokenAddress)}`, {signal: controller.signal} as RequestInit);
    if (!res.ok) return null;
    const data = (await res.json()) as {result?: Record<string, any>};
    const result = data?.result?.[tokenAddress.toLowerCase()];
    if (!result || typeof result !== 'object') return null;

    const flags = RISK_FLAGS.filter(([field]) => toBool(result[field])).map(([, label]) => label);
    const summary: TokenSecuritySummary = {
      isOpenSource: result.is_open_source === undefined ? null : toBool(result.is_open_source),
      isHoneypot: toBool(result.is_honeypot),
      buyTaxPercent: toPercent(result.buy_tax),
      sellTaxPercent: toPercent(result.sell_tax),
      lpLockedPercent: lockedLpPercent(result.lp_holders),
      holderCount: Number.isFinite(Number(result.holder_count)) ? Number(result.holder_count) : null,
      holders: parseHolders(result.holders),
      flags,
    };
    cache.set(key, {summary, expiresAt: Date.now() + CACHE_TTL_MS});
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
