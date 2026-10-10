import AsyncStorage from '@react-native-async-storage/async-storage';

export type KivoNotification = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
};

// Per wallet: message previews and wallet activity of one wallet must never be
// shown while another wallet (or no wallet) is active on this device.
const KEY_PREFIX = 'kivo:mobile:notifications:v1:';
const MAX_ITEMS = 100;

let owner: string | null = null;
/** Bumped on every owner change so a slow load never fills another wallet's list. */
let ownerGeneration = 0;
let notifications: KivoNotification[] = [];
const listeners = new Set<(items: KivoNotification[]) => void>();

function emit() {
  const snapshot = notifications.map(item => ({ ...item }));
  listeners.forEach(listener => listener(snapshot));
}

function save() {
  if (!owner) return;
  const key = KEY_PREFIX + owner;
  void AsyncStorage.setItem(key, JSON.stringify(notifications.slice(0, MAX_ITEMS))).catch(() => {});
}

function isNotification(value: unknown): value is KivoNotification {
  const item = value as KivoNotification | null;
  return Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string' && typeof item.createdAt === 'number');
}

/**
 * Switches the list to this wallet's notifications. Null (signed out / no
 * wallet) clears the in-memory list and shows nothing.
 */
export function setNotificationOwner(address: string | null) {
  const next = address ? address.trim().toLowerCase() : null; // mobile accounts are EVM-only
  if (next === owner) return;
  owner = next;
  const generation = ++ownerGeneration;
  notifications = [];
  emit();
  if (!next) return;
  void AsyncStorage.getItem(KEY_PREFIX + next).then(raw => {
    if (generation !== ownerGeneration) return;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const saved = Array.isArray(parsed) ? parsed.filter(isNotification).map(item => ({ ...item, read: Boolean(item.read) })) : [];
    // Keep anything added while the saved list was loading, newest first.
    const seen = new Set(notifications.map(item => item.id));
    notifications = [...notifications, ...saved.filter(item => !seen.has(item.id))].slice(0, MAX_ITEMS);
    emit();
  }).catch(() => {});
}

export function getNotifications() {
  return notifications.map(item => ({ ...item }));
}

export function subscribeToNotifications(listener: (items: KivoNotification[]) => void) {
  listeners.add(listener);
  listener(getNotifications());
  return () => { listeners.delete(listener); };
}

/** Adds a notification for the active wallet. Without an active wallet nothing is recorded. */
export function addNotification(title: string, body: string): KivoNotification | null {
  if (!owner) return null;
  const item: KivoNotification = {
    id: `notification-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    body,
    createdAt: Date.now(),
    read: false,
  };
  notifications = [item, ...notifications].slice(0, MAX_ITEMS);
  save();
  emit();
  return item;
}

export function markAllNotificationsRead() {
  notifications = notifications.map(item => ({ ...item, read: true }));
  save();
  emit();
}

export function clearNotifications() {
  notifications = [];
  save();
  emit();
}
