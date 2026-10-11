import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'kivo:settings:v1';

export type KivoSettings = {
  haptics: boolean;
  notifications: boolean;
  language: 'System' | 'English';
  hideSmallBalances: boolean;
  /** Mask portfolio / cash amounts on Profile and Wallet. */
  hideBalances: boolean;
  /** Max slippage for trade routes in basis points; null lets the router choose (Auto). */
  slippageBps: number | null;
};

const DEFAULT_SETTINGS: KivoSettings = {
  haptics: true,
  notifications: true,
  language: 'System',
  hideSmallBalances: false,
  hideBalances: false,
  slippageBps: null,
};

let settings: KivoSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(value: KivoSettings) => void>();

function emit() {
  const snapshot = { ...settings };
  listeners.forEach(listener => listener(snapshot));
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => {});
}

/** Restores saved settings (called once at startup). */
export async function loadSettings() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; emit(); }
  } catch { /* keep defaults */ }
}

export function getSettings() {
  return { ...settings };
}

export function subscribeToSettings(listener: (value: KivoSettings) => void) {
  listeners.add(listener);
  listener(getSettings());
  return () => { listeners.delete(listener); };
}

export function updateSettings(patch: Partial<KivoSettings>) {
  settings = { ...settings, ...patch };
  emit();
  return getSettings();
}

export function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  emit();
}

export function useSettings() {
  const [value, setValue] = useState(getSettings);
  useEffect(() => { return subscribeToSettings(setValue); }, []);
  return value;
}
