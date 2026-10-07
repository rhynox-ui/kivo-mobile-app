export type KivoNotification = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
};

let notifications: KivoNotification[] = [];
const listeners = new Set<(items: KivoNotification[]) => void>();

function emit() {
  const snapshot = notifications.map(item => ({ ...item }));
  listeners.forEach(listener => listener(snapshot));
}

export function getNotifications() {
  return notifications.map(item => ({ ...item }));
}

export function subscribeToNotifications(listener: (items: KivoNotification[]) => void) {
  listeners.add(listener);
  listener(getNotifications());
  return () => { listeners.delete(listener); };
}

export function addNotification(title: string, body: string) {
  const item: KivoNotification = {
    id: `notification-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    body,
    createdAt: Date.now(),
    read: false,
  };
  notifications = [item, ...notifications].slice(0, 100);
  emit();
  return item;
}

export function markAllNotificationsRead() {
  notifications = notifications.map(item => ({ ...item, read: true }));
  emit();
}

export function clearNotifications() {
  notifications = [];
  emit();
}
