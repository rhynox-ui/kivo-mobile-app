// Kivo referrals on mobile: the user's /api/referrals/me (cached per account),
// the 10% fee discount for referred users, the Play install referrer
// ("ref=<username>" from a Kivo referral link), claiming a referrer and
// reporting finished trades so referrers earn 25% of the fees.

import { useEffect, useState } from 'react';
import { Linking, NativeModules, Platform, Share } from 'react-native';
import { setReferralFeeDiscount } from '@kivo/trading/core/fees';
import { ApiError, type ReferralSource, type ReferralsMe, type ReferralUser } from '@kivo/shared/api/client';
import { validProfileUsername } from '@kivo/shared/social/validation';
import { api, ensureSolanaLinked, storage } from './session';

const ME_CACHE_PREFIX = 'kivo:referrals:v1:';
const INSTALL_REFERRER_KEY = 'kivo:install-referrer:v1';
const PENDING_CLAIM_KEY = 'kivo:referral-pending-claim:v1';
const LINK_CODE_KEY = 'kivo:referral-link-code:v1';
const REFERRAL_LINK_BASE = 'https://kivotrade.site/r/';

type CachedMe = { feeBps: number; referred: boolean };

let current: ReferralsMe | null = null;
let currentUserId: string | null = null;
let cachedReferred: boolean | null = null;
let syncStarted = false;
const listeners = new Set<(value: ReferralsMe | null) => void>();

function emit() { listeners.forEach(listener => listener(current)); }

function applyMe(userId: string, me: ReferralsMe) {
  if (api.signedInUserId() !== userId) return;
  current = me;
  currentUserId = userId;
  cachedReferred = Boolean(me.referredBy);
  setReferralFeeDiscount(me.feeBps === 45);
  const cache: CachedMe = { feeBps: me.feeBps, referred: Boolean(me.referredBy) };
  void Promise.resolve(storage.setItem(ME_CACHE_PREFIX + userId, JSON.stringify(cache))).catch(() => {});
  emit();
}

export function getReferrals(): ReferralsMe | null {
  return current && currentUserId === api.signedInUserId() ? current : null;
}

export function useReferrals(): ReferralsMe | null {
  const [value, setValue] = useState(getReferrals);
  useEffect(() => {
    const listener = () => setValue(getReferrals());
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return value;
}

/** Loads /api/referrals/me and applies the fee discount. Keeps the last copy when offline. */
export async function refreshReferrals(): Promise<ReferralsMe | null> {
  const userId = api.signedInUserId();
  if (!userId) return null;
  try {
    const me = await api.referralsMe();
    applyMe(userId, me);
    return getReferrals();
  } catch {
    return getReferrals();
  }
}

async function onSessionChanged() {
  const userId = api.signedInUserId();
  if (userId === currentUserId && (current || !userId)) return;
  current = null;
  currentUserId = userId;
  cachedReferred = null;
  emit();
  if (!userId) { setReferralFeeDiscount(false); return; }
  // The last known fee applies right away, before the network answers.
  try {
    const raw = await storage.getItem(ME_CACHE_PREFIX + userId);
    const cache = raw ? JSON.parse(raw) as CachedMe : null;
    if (api.signedInUserId() === userId) {
      setReferralFeeDiscount(cache?.feeBps === 45);
      cachedReferred = cache ? cache.referred === true : null;
    }
  } catch { setReferralFeeDiscount(false); }
  await claimPendingReferral();
  await refreshReferrals();
}

/** Called once at app start: follows sign-in, account switches and sign-out. */
export function startReferralSync() {
  if (syncStarted) return;
  syncStarted = true;
  api.onSessionChange(() => { void onSessionChanged(); });
  void onSessionChanged();
  // Referral App Links (https://kivotrade.site/r/<username>): cold start and while running.
  void Linking.getInitialURL().then(url => { if (url) handleReferralUrl(url); }).catch(() => {});
  Linking.addEventListener('url', event => { handleReferralUrl(event.url); });
}

// ---------------------------------------------------------------------------
// Referral links

/** "https://kivotrade.site/r/alice" → "alice" (strict username check), else null. */
export function parseReferralUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/(?:www\.)?kivotrade\.site\/r\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  if (!match) return null;
  let value: string;
  try { value = decodeURIComponent(match[1]).trim().replace(/^@/, ''); } catch { return null; }
  return validProfileUsername(value) ? value : null;
}

const linkListeners = new Set<(username: string) => void>();
let lastLinkCode: string | null = null;
let pendingLinkForUi: string | null = null;

/** Screens that can show "Who referred you?" listen for referral links opened while the app runs. */
export function subscribeReferralLinks(listener: (username: string) => void): () => void {
  linkListeners.add(listener);
  return () => { linkListeners.delete(listener); };
}

function handleReferralUrl(url: string) {
  const username = parseReferralUrl(url);
  if (!username) return;
  lastLinkCode = username;
  pendingLinkForUi = linkListeners.size ? null : username;
  void Promise.resolve(storage.setItem(LINK_CODE_KEY, username)).catch(() => {});
  linkListeners.forEach(listener => listener(username));
  // Opening a personalized link while signed in is attribution intent.
  // The backend still enforces the one-referrer, seven-day and pre-trade rules.
  if (api.signedInUserId()) {
    void queueReferralClaim(username, 'install').then(async () => {
      const me = await refreshReferrals();
      if (me?.referredBy?.username?.toLowerCase() === username.toLowerCase()) {
        await Promise.resolve(storage.removeItem?.(LINK_CODE_KEY)).catch(() => {});
      }
    }).catch(() => {});
  }
}

/** A referral link opened on this phone (newest first), else the Play install referrer. */
export async function getSuggestedReferrer(): Promise<string | null> {
  if (lastLinkCode) return lastLinkCode;
  try {
    const saved = await storage.getItem(LINK_CODE_KEY);
    if (saved && validProfileUsername(saved)) return saved;
  } catch { /* fall back to Play */ }
  return getInstallReferrerUsername();
}

/**
 * A referral link opened but not yet acted on (cold start, or while no screen
 * was listening). The main screen or sign-up takes it once.
 */
export function consumePendingReferralLink(): string | null {
  const code = pendingLinkForUi;
  pendingLinkForUi = null;
  return code;
}

// ---------------------------------------------------------------------------
// Play install referrer

/** "ref=alice" (or "ref%3Dalice", "utm_source=…&ref=alice") → "alice". Google's defaults → null. */
export function parseInstallReferrer(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let text = raw.trim();
  if (!text.includes('=') && /%3D/i.test(text)) {
    try { text = decodeURIComponent(text); } catch { return null; }
  }
  for (const part of text.split('&')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    if (key !== 'ref') continue;
    let value = part.slice(index + 1);
    try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return null; }
    value = value.trim().replace(/^@/, '');
    return validProfileUsername(value) ? value : null;
  }
  return null;
}

let installReferrerRead: Promise<string | null> | null = null;

/** The referrer's username from the Play install referrer, read from Play once per install. Never throws. */
export function getInstallReferrerUsername(): Promise<string | null> {
  if (installReferrerRead) return installReferrerRead;
  installReferrerRead = (async () => {
    try {
      const saved = await storage.getItem(INSTALL_REFERRER_KEY);
      if (saved != null) return parseInstallReferrer((JSON.parse(saved) as { raw?: string | null }).raw ?? null);
    } catch { /* read it again */ }
    if (Platform.OS !== 'android') return null;
    const native = NativeModules.InstallReferrerModule as { getInstallReferrer?: () => Promise<string | null> } | undefined;
    if (!native?.getInstallReferrer) return null;
    try {
      const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 12_000));
      const raw = await Promise.race([native.getInstallReferrer(), timeout]);
      if (raw === undefined) return null; // timed out: try again next launch
      const value = typeof raw === 'string' ? raw : null;
      await Promise.resolve(storage.setItem(INSTALL_REFERRER_KEY, JSON.stringify({ raw: value }))).catch(() => {});
      return parseInstallReferrer(value);
    } catch {
      return null;
    }
  })().catch(() => null);
  return installReferrerRead;
}

// ---------------------------------------------------------------------------
// Claiming a referrer

export function lookupReferrer(username: string): Promise<ReferralUser> {
  return api.lookupReferrer(username.trim().replace(/^@/, ''));
}

/** "Who referred you?" — sets the referrer, then reloads the rewards (and the fee discount). */
export async function claimReferrer(username: string, source: ReferralSource = 'manual'): Promise<ReferralUser> {
  const result = await api.claimReferral(username.trim().replace(/^@/, ''), source);
  cachedReferred = true;
  await refreshReferrals();
  return result.referredBy;
}

/**
 * Sign-up keeps the referrer typed (or pre-filled from Play) until the
 * account is signed in to Kivo, then claims it once. A refused claim
 * (unknown user, already set, …) is dropped; a network error retries later.
 */
export async function queueReferralClaim(username: string, source: ReferralSource): Promise<void> {
  const clean = username.trim().replace(/^@/, '');
  if (!validProfileUsername(clean)) return;
  await Promise.resolve(storage.setItem(PENDING_CLAIM_KEY, JSON.stringify({ username: clean, source }))).catch(() => {});
  await claimPendingReferral();
}

let pendingClaimInFlight: Promise<void> | null = null;
function claimPendingReferral(): Promise<void> {
  if (pendingClaimInFlight) return pendingClaimInFlight;
  pendingClaimInFlight = (async () => {
    if (!api.signedInUserId()) return;
    let pending: { username: string; source: ReferralSource } | null = null;
    try {
      const raw = await storage.getItem(PENDING_CLAIM_KEY);
      pending = raw ? JSON.parse(raw) : null;
    } catch { pending = null; }
    if (!pending?.username) return;
    try {
      await claimReferrer(pending.username, pending.source === 'install' ? 'install' : 'manual');
      await Promise.resolve(storage.removeItem?.(PENDING_CLAIM_KEY)).catch(() => {});
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) {
        await Promise.resolve(storage.removeItem?.(PENDING_CLAIM_KEY)).catch(() => {});
      }
    }
  })().finally(() => { pendingClaimInFlight = null; });
  return pendingClaimInFlight;
}

// ---------------------------------------------------------------------------
// Sharing

export function referralLink(username: string, me?: ReferralsMe | null): string {
  return me?.link || REFERRAL_LINK_BASE + encodeURIComponent(username);
}

/** The link as shown on screen: "kivotrade.site/r/alice". */
export function shortReferralLink(link: string): string {
  return link.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function referralShareMessage(link: string): string {
  return `Trade with me on Kivo and get 10% off fees!\n\n${link}`;
}

export function shareReferralLink(link: string): void {
  void Share.share({ message: referralShareMessage(link) }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Trade reporting

const reported = new Set<string>();

async function traderHasReferrer(): Promise<boolean> {
  if (!api.signedInUserId()) return false;
  const me = getReferrals();
  if (me) return Boolean(me.referredBy);
  if (cachedReferred != null) return cachedReferred;
  const fresh = await refreshReferrals();
  return Boolean(fresh?.referredBy);
}

/**
 * Fire-and-forget after every successful trade: the server verifies the
 * transaction on-chain and credits the referrer. Only sent when this user
 * has a referrer. When the server needs the Solana wallet linked, it is
 * linked with a signed message (the key never leaves the phone) and the
 * report is retried once.
 */
export function reportReferralTrade(input: { chain: string; txHash?: string | null; requestId?: string | null }, delayMs = 0): void {
  const txHash = input.txHash?.trim();
  if (!txHash || !input.chain) return;
  const id = `${input.chain}:${txHash}`;
  if (reported.has(id)) return;
  reported.add(id);
  void (async () => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (!(await traderHasReferrer())) return;
    const body = { chain: input.chain, txHash, ...(input.requestId ? { requestId: input.requestId } : {}) };
    let result = await api.reportReferralTrade(body);
    if (result.needsSolanaLink) {
      const linked = await ensureSolanaLinked({ force: true }).catch(() => false);
      if (!linked) return;
      result = await api.reportReferralTrade(body);
    }
    if (result.recorded) void refreshReferrals();
  })().catch(() => { reported.delete(id); });
}
