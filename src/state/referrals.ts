// Kivo referrals on mobile: the user's /api/referrals/me (cached per account),
// the 10% fee discount for referred users, the Play install referrer
// ("ref=<username>" from a Kivo referral link), claiming a referrer and
// reporting finished trades so referrers earn 25% of the fees.

import { useEffect, useState } from 'react';
import { Linking, NativeModules, Platform, Share } from 'react-native';
import { setReferralFeeDiscount } from '@kivo/trading/core/fees';
import { ApiError, type ReferralSource, type ReferralsMe, type ReferralUser } from '@kivo/shared/api/client';
import { validProfileUsername } from '@kivo/shared/social/validation';
import { walletAddressOfUserId } from '@kivo/shared/api/types';
import { api, ensureSolanaLinked, storage } from './session';
import { getWalletSession } from './walletStore';

const ME_CACHE_PREFIX = 'kivo:referrals:v1:';
const INSTALL_REFERRER_KEY = 'kivo:install-referrer:v1';
// Pending claim, per wallet: a referrer typed at sign-up belongs to that account only.
const PENDING_CLAIM_KEY = 'kivo:referral-pending-claim:v2:';
const LEGACY_PENDING_CLAIM_KEY = 'kivo:referral-pending-claim:v1';
// Unreported trades, per wallet (see reportReferralTrade).
const REPORT_QUEUE_KEY = 'kivo:referral-report-queue:v1:';
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
  if (!userId) { setReferralFeeDiscount(false); clearReportTimer(); return; }
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
  // A new session (app launch or sign-in) retries every queued report, even
  // those whose quick retries are used up.
  void flushReportQueue(true);
}

/** Called once at app start: follows sign-in, account switches and sign-out. */
export function startReferralSync() {
  if (syncStarted) return;
  syncStarted = true;
  api.onSessionChange(() => { void onSessionChanged(); });
  // The old global pending claim cannot be tied to an account; never let the next account claim it.
  void Promise.resolve(storage.removeItem?.(LEGACY_PENDING_CLAIM_KEY)).catch(() => {});
  void onSessionChanged();
  // Referral App Links (https://kivotrade.site/r/<username>): cold start and while running.
  void Linking.getInitialURL().then(url => { if (url) handleReferralUrl(url); }).catch(() => {});
  Linking.addEventListener('url', event => { handleReferralUrl(event.url); });
}

// ---------------------------------------------------------------------------
// Referral links

/**
 * "https://kivotrade.site/r/alice" → "alice" (strict username check), else null.
 * Only the host the App Link filter (AndroidManifest) and assetlinks.json
 * verify: a www link never opens the app, so it is not accepted here either.
 */
export function parseReferralUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/kivotrade\.site\/r\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(url.trim());
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
  const address = getWalletSession()?.address;
  if (!validProfileUsername(clean) || !address) return;
  await Promise.resolve(storage.setItem(PENDING_CLAIM_KEY + address.toLowerCase(), JSON.stringify({ username: clean, source }))).catch(() => {});
  await claimPendingReferral();
}

let pendingClaimInFlight: Promise<void> | null = null;
function claimPendingReferral(): Promise<void> {
  if (pendingClaimInFlight) return pendingClaimInFlight;
  pendingClaimInFlight = (async () => {
    const userId = api.signedInUserId();
    if (!userId) return;
    const key = PENDING_CLAIM_KEY + walletAddressOfUserId(userId).toLowerCase();
    let pending: { username: string; source: ReferralSource } | null = null;
    try {
      const raw = await storage.getItem(key);
      pending = raw ? JSON.parse(raw) : null;
    } catch { pending = null; }
    if (!pending?.username) return;
    try {
      if (api.signedInUserId() !== userId) return;
      await claimReferrer(pending.username, pending.source === 'install' ? 'install' : 'manual');
      await Promise.resolve(storage.removeItem?.(key)).catch(() => {});
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) {
        await Promise.resolve(storage.removeItem?.(key)).catch(() => {});
      }
    }
  })().finally(() => { pendingClaimInFlight = null; });
  return pendingClaimInFlight;
}

// ---------------------------------------------------------------------------
// Sharing

/**
 * The account's referral link (https://kivotrade.site/r/<username>), or null
 * while the username exists only on this phone: a link to a username Kivo's
 * server does not know would not credit anyone. `published` is whether the
 * local username is on the server (used when /me has not loaded).
 */
export function referralLink(me: ReferralsMe | null | undefined, localUsername?: string | null, published?: boolean): string | null {
  if (me) {
    // Older servers answer link "https://kivotrade.site" for an account without a username.
    if (!me.username || !validProfileUsername(me.username)) return null;
    return me.link && me.link.startsWith(REFERRAL_LINK_BASE) ? me.link : REFERRAL_LINK_BASE + encodeURIComponent(me.username);
  }
  return published && localUsername && validProfileUsername(localUsername) ? REFERRAL_LINK_BASE + encodeURIComponent(localUsername) : null;
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
//
// Every finished trade is queued on the phone (per wallet) before it is
// reported, so a report the server cannot check yet ({retry: true}), a network
// error or a closed app never loses the referrer's reward. Retries back off
// 1 min, 5 min, 30 min, 2 h, then once per app launch / sign-in, for 7 days.

type QueuedReport = { chain: string; txHash: string; requestId?: string; addedAt: number; attempts: number; nextAt: number };
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE = 100;
const reported = new Set<string>();
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let queueWrite: Promise<unknown> = Promise.resolve();

function clearReportTimer() { if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; } }

function queueKey(address: string) { return REPORT_QUEUE_KEY + address.toLowerCase(); }

async function readQueue(address: string): Promise<QueuedReport[]> {
  try {
    const raw = await storage.getItem(queueKey(address));
    const rows = raw ? JSON.parse(raw) as QueuedReport[] : [];
    return Array.isArray(rows) ? rows.filter(r => r && typeof r.chain === 'string' && typeof r.txHash === 'string') : [];
  } catch { return []; }
}

/** Serialized read-modify-write of one wallet's queue. */
function updateQueue(address: string, change: (rows: QueuedReport[]) => QueuedReport[]): Promise<QueuedReport[]> {
  const run = queueWrite.then(async () => {
    const next = change(await readQueue(address)).slice(-MAX_QUEUE);
    await Promise.resolve(next.length ? storage.setItem(queueKey(address), JSON.stringify(next)) : storage.removeItem?.(queueKey(address))).catch(() => {});
    return next;
  });
  queueWrite = run.catch(() => undefined);
  return run;
}

async function traderHasReferrer(): Promise<boolean | null> {
  if (!api.signedInUserId()) return null;
  const me = getReferrals();
  if (me) return Boolean(me.referredBy);
  if (cachedReferred != null) return cachedReferred;
  const fresh = await refreshReferrals();
  return fresh ? Boolean(fresh.referredBy) : null;
}

type Outcome = 'done' | 'retry';

async function sendReport(row: QueuedReport): Promise<Outcome> {
  const hasReferrer = await traderHasReferrer();
  if (hasReferrer === false) return 'done';
  if (hasReferrer == null) return 'retry';
  const body = { chain: row.chain, txHash: row.txHash, ...(row.requestId ? { requestId: row.requestId } : {}) };
  try {
    let result = await api.reportReferralTrade(body);
    if (result.needsSolanaLink) {
      const linked = await ensureSolanaLinked({ force: true }).catch(() => false);
      if (!linked) return 'retry';
      result = await api.reportReferralTrade(body);
    }
    if (result.recorded) { void refreshReferrals(); return 'done'; }
    return result.retry || result.needsSolanaLink ? 'retry' : 'done';
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    // Refused for good (not a Kivo trade, already recorded, …): stop. Offline, 401, 408, 429, 5xx: retry.
    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429 ? 'done' : 'retry';
  }
}

let flushing: Promise<void> | null = null;
/** Sends due reports for the signed-in wallet. `all`: also those waiting for the next launch. */
function flushReportQueue(all = false): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    clearReportTimer();
    const userId = api.signedInUserId();
    if (!userId) return;
    const address = walletAddressOfUserId(userId);
    const now = Date.now();
    const rows = await readQueue(address);
    const results = new Map<string, Outcome>();
    for (const row of rows) {
      if (now - row.addedAt > REPORT_MAX_AGE_MS) { results.set(row.chain + ':' + row.txHash, 'done'); continue; }
      if (!all && row.nextAt > now) continue;
      if (api.signedInUserId() !== userId) break;
      results.set(row.chain + ':' + row.txHash, await sendReport(row));
    }
    const remaining = await updateQueue(address, current => current.flatMap(row => {
      const outcome = results.get(row.chain + ':' + row.txHash);
      if (outcome === 'done') return [];
      if (outcome !== 'retry') return [row];
      const attempts = row.attempts + 1;
      // Quick retries used up: wait for the next launch / sign-in.
      const nextAt = attempts <= RETRY_DELAYS_MS.length ? Date.now() + RETRY_DELAYS_MS[attempts - 1] : Number.MAX_SAFE_INTEGER;
      return [{ ...row, attempts, nextAt }];
    }));
    if (api.signedInUserId() !== userId) return;
    const next = Math.min(...remaining.map(r => r.nextAt));
    if (Number.isFinite(next) && next < Number.MAX_SAFE_INTEGER) {
      reportTimer = setTimeout(() => { void flushReportQueue(); }, Math.max(1_000, next - Date.now()));
    }
  })().catch(() => {}).finally(() => { flushing = null; });
  return flushing;
}

/**
 * Called after every successful trade: queued on the phone, then reported so
 * the server can verify the transaction on-chain and credit the referrer
 * (only when this user has a referrer). When the server needs the Solana
 * wallet linked, it is linked with a signed message (the key never leaves the
 * phone). `delayMs`: wait before the first attempt (e.g. a pending bridge).
 */
export function reportReferralTrade(input: { chain: string; txHash?: string | null; requestId?: string | null }, delayMs = 0): void {
  const txHash = input.txHash?.trim();
  const address = getWalletSession()?.address;
  if (!txHash || !input.chain || !address) return;
  const id = `${input.chain}:${txHash}`;
  if (reported.has(id)) return;
  reported.add(id);
  const row: QueuedReport = { chain: input.chain, txHash, ...(input.requestId ? { requestId: input.requestId } : {}), addedAt: Date.now(), attempts: 0, nextAt: Date.now() + Math.max(0, delayMs) };
  void updateQueue(address, rows => rows.some(r => r.chain === row.chain && r.txHash === row.txHash) ? rows : [...rows, row])
    .then(() => {
      if (delayMs > 0) {
        setTimeout(() => { void flushReportQueue(); }, delayMs);
      } else {
        void flushReportQueue();
      }
    })
    .catch(() => { reported.delete(id); });
}
