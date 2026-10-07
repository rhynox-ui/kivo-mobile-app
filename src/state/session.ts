// Mobile session bootstrap: wires the shared Kivo stores (profile, chat,
// trade history) and the Kivo social API to AsyncStorage and to the active
// wallet session — the same way the web client wires them to the browser.

import { configureRelayEndpoints } from '@kivo/trading/core/relayQuote';
import { configureRelayExecuteUrl } from '@kivo/trading/core/relayGaslessEvm';
import { configureGaslessStatusUrl } from '@kivo/trading/kivo/gasless';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

export const storage: KeyValueStorage = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
};

export const api = new KivoApi({ baseUrl: KIVO_API_BASE_URL, storage, client: 'mobile' });

let started = false;
let lastAddress: string | null | undefined;

export async function startKivoSession() {
  if (started) return;
  started = true;
  await loadSettings();
  configureProfileStore({ storage });
  configureTradeHistory({ storage });
  // Mobile model (like Mango Pro): the device wallet signs, the user only
  // needs USDC, and Relay submits the trade with Kivo covering gas.
  configureRelayEndpoints({ quoteUrl: `${KIVO_API_BASE_URL}/api/relay/quote`, sponsorship: true });
  configureRelayExecuteUrl(`${KIVO_API_BASE_URL}/api/relay/execute`);
  configureGaslessStatusUrl(`${KIVO_API_BASE_URL}/api/relay/config`);
  // Phones are the archive: keep a deep local history per conversation.
  configureChat({
    api,
    storage,
    maxPerConversation: 3000,
    onIncoming: (conversation, message) => addNotification(conversation?.title ?? 'New message', message.text ? message.text.slice(0, 90) : '📷 Photo'),
  });
  subscribeToWallet(wallet => {
    const address = wallet?.address ?? null;
    if (address?.toLowerCase() === lastAddress?.toLowerCase()) return;
    lastAddress = address;
    stopChatSync();
    void (async () => {
      await Promise.all([activateProfileForWallet(address), activateTradeHistory(address), activateChat(address)]);
      if (await api.restore(address)) { void pullServerProfile(); startChatSync(); }
    })();
  });
}

/** One device-wallet signature (plain text, no transaction) turns on chats, communities and profile sync. */
export async function enableSocial() {
  const wallet = getWalletSession();
  if (!wallet) throw new Error('Set up a wallet first.');
  await api.signIn(wallet.address, signMessageWithLocalWallet);
  await pullServerProfile();
  startChatSync();
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
    } else if (!me.username && local.username && !local.username.startsWith('kivo_')) {
      await api.updateProfile({ username: local.username, bio: local.bio }).catch(() => {});
    }
  } catch { /* offline: keep the local copy */ }
}
