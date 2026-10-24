// Mobile session bootstrap: wires the shared Kivo stores (profile, chat,
// trade history) and the Kivo social API to AsyncStorage and to the active
// wallet session — the same way the web client wires them to the browser.

import { configureRelayEndpoints } from '@kivo/trading/core/relayQuote';
import { configureMarketHosts } from '@kivo/trading/core/marketHosts';
import { configureGaslessStatusUrl } from '@kivo/trading/kivo/gasless';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { AppState, NativeModules, Platform } from 'react-native';
import { useEffect, useState } from 'react';
import type { KeyValueStorage } from '@kivo/shared/storage';
import { KivoApi } from '@kivo/shared/api/client';
import { activateChat, configureChat, startChatSync, stopChatSync } from '@kivo/shared/chat/store';
import { activateProfileForWallet, configureProfileStore, getProfile, hasSavedProfile, updateProfile } from '@kivo/shared/profile/store';
import { activateTradeHistory, configureTradeHistory } from '@kivo/trading/kivo/history';
import { addNotification, setNotificationOwner } from './notificationStore';
import { requestNotificationPermission } from '../notifications/localNotify';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { getWalletSession, requireSolana, subscribeToWallet, walletUnlockedOnDevice, withDeviceAccounts } from './walletStore';
import { signKivoMessage } from './signGuard';
import { loadSettings } from './settingsStore';
import { applyClientLimits } from '@kivo/shared/api/types';

/** Same Cloudflare Pages project as the web app (stable URL). */
export const KIVO_API_BASE_URL = 'https://kivo-web.pages.dev';

const SESSION_SERVICE = 'com.kivo.chat.api-session';
const secureSessionStorage: KeyValueStorage = {
  async getItem(key) {
    const credentials = await Keychain.getGenericPassword({service: SESSION_SERVICE});
    return credentials && credentials.username === key ? credentials.password : null;
  },
  async setItem(key, value) {
    await Keychain.setGenericPassword(key, value, {
      service: SESSION_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async removeItem() {
    await Keychain.resetGenericPassword({service: SESSION_SERVICE});
  },
};

export const storage: KeyValueStorage = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
};

export const api = new KivoApi({ baseUrl: KIVO_API_BASE_URL, storage, sessionStorage: secureSessionStorage, client: 'mobile' });

/** Register this install's native FCM token against the currently authenticated Kivo wallet. */
async function registerPushTokenForSession(): Promise<void> {
  const native = NativeModules.KivoPushModule as {getToken?: () => Promise<string>} | undefined;
  if (!api.signedInUserId() || typeof native?.getToken !== 'function') return;
  try {
    if (!(await requestNotificationPermission())) return;
    const token = await native.getToken();
    if (token) await api.registerPushDevice(token, Platform.OS === 'ios' ? 'ios' : 'android');
  } catch {
    // FCM is optional until the Firebase app config is present in the native build.
  }
}


let started = false;
let lastAddress: string | null | undefined;
// Wallet activations touch several shared stores and AsyncStorage. Serialize
// them so a slow restore for wallet A cannot finish after wallet B is selected.
let walletActivationQueue: Promise<void> = Promise.resolve();

function isCurrentWallet(address: string | null): boolean {
  return (getWalletSession()?.address ?? null)?.toLowerCase() === address?.toLowerCase();
}

function syncChatForAppState() {
  if (AppState.currentState === 'active' && socialReady()) {
    startChatSync(() => AppState.currentState === 'active' && socialReady());
  } else {
    stopChatSync();
  }
}

const LIMITS_KEY = 'kivo:limits:v1';

/**
 * Applies the Blue Star rules the server enforces (GET /api/limits): first the
 * last copy saved on this phone, then a fresh one. Rule changes therefore reach
 * the app without an update; the built-in values are only a fallback.
 */
async function loadLiveLimits(): Promise<void> {
  try { const saved = await storage.getItem(LIMITS_KEY); if (saved) applyClientLimits(JSON.parse(saved)); } catch {}
  try {
    const fresh = await api.limits();
    if (applyClientLimits(fresh)) await Promise.resolve(storage.setItem(LIMITS_KEY, JSON.stringify(fresh))).catch(() => {});
  } catch { /* offline or older server: keep what we have */ }
}

export async function startKivoSession() {
  if (started) return;
  started = true;
  await loadSettings();
  configureProfileStore({ storage });
  configureTradeHistory({ storage });
  void loadLiveLimits();
  // GeckoTerminal (trending, charts) is tried directly first; when it rate
  // limits, Kivo's caching proxy answers instead of an empty list.
  configureMarketHosts({ geckoterminal: `${KIVO_API_BASE_URL}/api/market/geckoterminal` });
  // Configure Relay immediately so the app does not block startup on a
  // network request. Sponsorship is confirmed in the background from Kivo's
  // backend before it is advertised/used.
  const relayQuoteUrl = `${KIVO_API_BASE_URL}/api/relay/quote`;
  const relayExecuteUrl = `${KIVO_API_BASE_URL}/api/relay/execute`;
  const relayConfigUrl = `${KIVO_API_BASE_URL}/api/relay/config`;
  configureRelayEndpoints({ quoteUrl: relayQuoteUrl, sponsorship: false });configureGaslessStatusUrl(relayConfigUrl);
  void (async () => {
    try {
      const response = await fetch(relayConfigUrl);
      const body = await response.json().catch(() => ({})) as {gasless?: boolean};
      configureRelayEndpoints({ quoteUrl: relayQuoteUrl, sponsorship: response.ok && body.gasless === true });
    } catch {
      // Keep Relay configured without sponsorship if the network is unavailable.
    }
  })();
  // Phones are the archive: keep a deep local history per conversation.
  configureChat({
    api,
    storage,
    maxPerConversation: 3000,
    // Shown in the phone's shade only while Kivo is in the background.
    onIncoming: (conversation, message) => addNotification(conversation?.title ?? 'New message', message.text ? message.text.slice(0, 90) : '📷 Photo', { system: AppState.currentState !== 'active' }),
  });
  AppState.addEventListener('change', syncChatForAppState);
  // Link the device's Solana wallet to the account once (for Solana holder gates).
  subscribeToWallet(() => autoLinkSolana());
  api.onSessionChange(() => { autoLinkSolana(); void registerPushTokenForSession(); });
  subscribeToWallet(wallet => {
    const address = wallet?.address ?? null;
    if (address?.toLowerCase() === lastAddress?.toLowerCase()) return;
    lastAddress = address;
    stopChatSync();
    // Notifications belong to one wallet: switch (or clear on sign-out) before
    // anything for the new wallet can be recorded.
    setNotificationOwner(address);
    // Invalidate the previous API session immediately, before queued local
    // stores or a slow restore can leave the old wallet authenticated.
    void api.restore(address).catch(() => {});
    walletActivationQueue = walletActivationQueue.then(async () => {
      // Skip stale queued switches; only the currently selected wallet may
      // restore the API session or restart background chat synchronization.
      if (!isCurrentWallet(address)) return;
      await Promise.all([activateProfileForWallet(address), activateTradeHistory(address), activateChat(address)]);
      if (!isCurrentWallet(address)) {
        stopChatSync();
        return;
      }
      if (await api.restore(address)) {
        if (!isCurrentWallet(address)) {
          stopChatSync();
          return;
        }
        void pullServerProfile();
        void registerPushTokenForSession();
        syncChatForAppState();
      }
    }).catch(() => {
      // A failed local-store activation must not leave background sync running
      // against a wallet that is no longer selected.
      if (!isCurrentWallet(address)) stopChatSync();
    });
  });
}

/**
 * Whether this wallet already has a Kivo profile, on this phone or on Kivo's
 * server (a wallet imported or restored from Google keeps its account), so
 * onboarding never asks an existing user to create a profile again. The
 * server's name and bio are applied locally right away. Unknown (offline)
 * counts as new: the profile screen is only a username field.
 */
export async function hasExistingProfile(): Promise<boolean> {
  const wallet = getWalletSession();
  if (!wallet) return false;
  if (await hasSavedProfile(wallet.address)) return true;
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
    const [found] = await Promise.race([api.searchProfiles(wallet.address), timeout]);
    if (!found?.username || found.address?.toLowerCase() !== wallet.address.toLowerCase()) return false;
    try {
      if (getProfile().walletAddress?.toLowerCase() !== wallet.address.toLowerCase()) await activateProfileForWallet(wallet.address);
      updateProfile({ username: found.username, bio: found.bio ?? '' });
    } catch { /* keep the local default until the server sync */ }
    return true;
  } catch {
    return false;
  }
}

/** One device-wallet signature (plain text, no transaction) turns on chats, communities and profile sync. */
export async function enableSocial() {
  const wallet = getWalletSession();
  if (!wallet) throw new Error('Set up a wallet first.');
  await api.signIn(wallet.address, message => signKivoMessage(message, 'sign-in'));
  await pullServerProfile();
  await registerPushTokenForSession();
  syncChatForAppState();
}

export function socialReady(): boolean {
  const wallet = getWalletSession();
  return Boolean(wallet && api.isSignedIn(wallet.address));
}

export function useSocialReady(): boolean {
  const [ready, setReady] = useState(socialReady);
  useEffect(() => {
    const update = () => setReady(socialReady());
    const unsubApi = api.onSessionChange(update);
    const unsubWallet = subscribeToWallet(update);
    return () => { unsubApi(); unsubWallet(); };
  }, []);
  return ready;
}

const SOLANA_LINK_KEY = 'kivo:solana-linked:v1:';
const autoLinkTried = new Set<string>();
let solanaLinkInFlight: Promise<boolean> | null = null;

/**
 * Proves to Kivo that this account (kivo:0x…) also controls the device's
 * Solana wallet, so Solana-token holder gates can read its balance. Signs one
 * plain-text message with the Solana key; the key itself never leaves the
 * phone. Remembered per account, so it happens once.
 */
export function ensureSolanaLinked({ interactive = false, force = false }: { interactive?: boolean; force?: boolean } = {}): Promise<boolean> {
  if (solanaLinkInFlight) return solanaLinkInFlight;
  const run = async () => {
    const wallet = getWalletSession();
    const userId = api.signedInUserId();
    if (!wallet || wallet.source !== 'local' || !wallet.solanaAddress || !userId || !socialReady()) return false;
    const solanaAddress = wallet.solanaAddress;
    const key = SOLANA_LINK_KEY + userId;
    // force: the server said no wallet is linked, so the remembered link is stale.
    if (!force && await Promise.resolve(storage.getItem(key)).catch(() => null) === solanaAddress) return true;
    // Never pop a biometric prompt on our own: background linking waits for an unlocked wallet.
    if (!interactive && !walletUnlockedOnDevice()) return false;
    const signature = await withDeviceAccounts('Link your Solana wallet', async ({ solana }) => {
      const keypair = requireSolana(solana);
      if (keypair.publicKey.toBase58() !== solanaAddress) throw new Error('The unlocked wallet does not match the active session.');
      const message = new TextEncoder().encode(`Kivo: link Solana wallet ${solanaAddress} to ${userId}`);
      return bs58.encode(ed25519.sign(message, keypair.secretKey.slice(0, 32)));
    });
    if (api.signedInUserId() !== userId) return false;
    await api.linkSolanaWallet(solanaAddress, signature);
    await Promise.resolve(storage.setItem(key, solanaAddress)).catch(() => {});
    return true;
  };
  solanaLinkInFlight = run().finally(() => { solanaLinkInFlight = null; });
  return solanaLinkInFlight;
}

function autoLinkSolana() {
  const wallet = getWalletSession();
  const userId = api.signedInUserId();
  if (!wallet?.solanaAddress || !userId || !socialReady() || !walletUnlockedOnDevice()) return;
  const attempt = userId + '|' + wallet.solanaAddress;
  if (autoLinkTried.has(attempt)) return;
  autoLinkTried.add(attempt);
  void ensureSolanaLinked().catch(() => { autoLinkTried.delete(attempt); });
}

async function pullServerProfile() {
  try {
    const me = await api.me();
    const wallet = getWalletSession();
    if (wallet && me.address?.toLowerCase() === wallet.address.toLowerCase()) setPublishState(wallet.address, me.username ? 'published' : 'local-only');
    const local = getProfile();
    if (me.username && (me.username !== local.username || me.bio !== local.bio || (me.avatarUrl ?? undefined) !== local.avatarUri)) {
      updateProfile({ username: me.username, bio: me.bio, avatarUri: me.avatarUrl ?? undefined });
    }
    // Never publish a local profile change silently. Profile mutations require an explicit wallet approval from the user.
  } catch { /* offline: keep the local copy */ }
}

// ---------------------------------------------------------------------------
// Publishing the username
//
// Profile setup chooses a username on the phone. Kivo's server only learns it
// from a signed profile approval; until then other people see this account's
// short wallet and referral links cannot point at it. Setup publishes it right
// away; an account whose username is still only on this phone gets a one-tap
// prompt on Profile. The key never leaves the phone and nothing on-chain is signed.

export type UsernamePublishState = 'unknown' | 'published' | 'local-only';
let publishState: { address: string; state: UsernamePublishState } | null = null;
const publishListeners = new Set<() => void>();

function setPublishState(address: string, state: UsernamePublishState) {
  const key = address.toLowerCase();
  if (publishState?.address === key && publishState.state === state) return;
  publishState = { address: key, state };
  publishListeners.forEach(listener => listener());
}

/** Records the result of a profile save the server accepted. */
export function notePublishedUsername(username: string | null) {
  const wallet = getWalletSession();
  if (wallet) setPublishState(wallet.address, username ? 'published' : 'local-only');
}

/** Whether the active wallet's username is on Kivo's server ('unknown' until checked). */
export function getUsernamePublishState(): UsernamePublishState {
  const wallet = getWalletSession();
  if (!wallet || publishState?.address !== wallet.address.toLowerCase()) return 'unknown';
  return publishState.state;
}

let publishCheck: Promise<UsernamePublishState> | null = null;
/** Asks Kivo's public profile lookup (no signature) whether this wallet has a server username. */
export function refreshUsernamePublishState(): Promise<UsernamePublishState> {
  if (publishCheck) return publishCheck;
  publishCheck = (async () => {
    const wallet = getWalletSession();
    if (!wallet) return 'unknown' as const;
    try {
      const found = await api.searchProfiles(wallet.address);
      const mine = found.find(p => p.address?.toLowerCase() === wallet.address.toLowerCase());
      if (isCurrentWallet(wallet.address)) setPublishState(wallet.address, mine?.username ? 'published' : 'local-only');
    } catch { /* offline: keep what we know */ }
    return getUsernamePublishState();
  })().finally(() => { publishCheck = null; });
  return publishCheck;
}

export function useUsernamePublishState(): UsernamePublishState {
  const [state, setState] = useState(getUsernamePublishState);
  useEffect(() => {
    const update = () => setState(getUsernamePublishState());
    publishListeners.add(update);
    const unsubWallet = subscribeToWallet(update);
    update();
    if (getUsernamePublishState() === 'unknown') void refreshUsernamePublishState();
    return () => { publishListeners.delete(update); unsubWallet(); };
  }, []);
  return state;
}

let publishInFlight: Promise<string> | null = null;
/**
 * Publishes the phone's username (and bio) to Kivo with one approval: a
 * plain-text profile approval signed on this phone, preceded by Kivo's sign-in
 * message when the account is not signed in yet. Resolves the published name.
 */
export function publishUsername(): Promise<string> {
  if (publishInFlight) return publishInFlight;
  publishInFlight = (async () => {
    const wallet = getWalletSession();
    if (!wallet) throw new Error('Set up a wallet first.');
    if (wallet.source !== 'local') throw new Error('This wallet is watch-only on this device.');
    if (!socialReady()) await api.signIn(wallet.address, message => signKivoMessage(message, 'sign-in'));
    if (!isCurrentWallet(wallet.address)) throw new Error('Wallet changed. Please try again.');
    const local = getProfile();
    const username = local.username.trim().replace(/^@/, '').toLowerCase();
    const bio = local.bio;
    const approval = await api.requestProfileApproval({ username, bio, avatarAction: 'keep' });
    const signature = await signKivoMessage(approval.message, 'profile');
    const saved = await api.updateProfile({ username, bio, approvalNonce: approval.nonce, approvalSignature: signature, approvalAvatarAction: 'keep' });
    if (!isCurrentWallet(wallet.address)) return saved.username ?? username;
    setPublishState(wallet.address, saved.username ? 'published' : 'local-only');
    try { updateProfile({ username: saved.username ?? username, bio: saved.bio ?? bio, avatarUri: saved.avatarUrl ?? local.avatarUri }); } catch { /* keep the local copy */ }
    void registerPushTokenForSession();
    syncChatForAppState();
    return saved.username ?? username;
  })().finally(() => { publishInFlight = null; });
  return publishInFlight;
}
