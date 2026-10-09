// Mobile session bootstrap: wires the shared Kivo stores (profile, chat,
// trade history) and the Kivo social API to AsyncStorage and to the active
// wallet session — the same way the web client wires them to the browser.

import { configureRelayEndpoints } from '@kivo/trading/core/relayQuote';
import { configureGaslessStatusUrl } from '@kivo/trading/kivo/gasless';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { AppState } from 'react-native';
import { useEffect, useState } from 'react';
import type { KeyValueStorage } from '@kivo/shared/storage';
import { KivoApi } from '@kivo/shared/api/client';
import { activateChat, configureChat, startChatSync, stopChatSync } from '@kivo/shared/chat/store';
import { activateProfileForWallet, configureProfileStore, getProfile, updateProfile } from '@kivo/shared/profile/store';
import { activateTradeHistory, configureTradeHistory } from '@kivo/trading/kivo/history';
import { addNotification } from './notificationStore';
import { getWalletSession, signMessageWithLocalWallet, subscribeToWallet } from './walletStore';
import { loadSettings } from './settingsStore';

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

export async function startKivoSession() {
  if (started) return;
  started = true;
  await loadSettings();
  configureProfileStore({ storage });
  configureTradeHistory({ storage });
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
    onIncoming: (conversation, message) => addNotification(conversation?.title ?? 'New message', message.text ? message.text.slice(0, 90) : '📷 Photo'),
  });
  AppState.addEventListener('change', syncChatForAppState);
  subscribeToWallet(wallet => {
    const address = wallet?.address ?? null;
    if (address?.toLowerCase() === lastAddress?.toLowerCase()) return;
    lastAddress = address;
    stopChatSync();
    // Invalidate the previous API session immediately, before queued local
    // stores or a slow restore can leave the old wallet authenticated.
    void api.restore(address);
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
        syncChatForAppState();
      }
    }).catch(() => {
      // A failed local-store activation must not leave background sync running
      // against a wallet that is no longer selected.
      if (!isCurrentWallet(address)) stopChatSync();
    });
  });
}

/** One device-wallet signature (plain text, no transaction) turns on chats, communities and profile sync. */
export async function enableSocial() {
  const wallet = getWalletSession();
  if (!wallet) throw new Error('Set up a wallet first.');
  await api.signIn(wallet.address, signMessageWithLocalWallet);
  await pullServerProfile();
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

async function pullServerProfile() {
  try {
    const me = await api.me();
    const local = getProfile();
    if (me.username && (me.username !== local.username || me.bio !== local.bio || (me.avatarUrl ?? undefined) !== local.avatarUri)) {
      updateProfile({ username: me.username, bio: me.bio, avatarUri: me.avatarUrl ?? undefined });
    }
    // Never publish a local profile change silently. Profile mutations require an explicit wallet approval from the user.
  } catch { /* offline: keep the local copy */ }
}
