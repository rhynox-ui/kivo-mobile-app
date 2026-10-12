// src/notifications/localNotify.ts
//
// Thin wrapper around the LocalNotifyModule native module (see
// android/app/src/main/java/com/kivo/chat/LocalNotifyModule.kt
// for the full rationale). This is a local, device-only notification —
// nothing is sent to or received from any server — used for surfacing
// trades, deposits and withdrawals as a real system notification
// (the notification shade), not just an in-app toast, per an explicit
// request to notify "just like" a real Android notification.
//
// Every export here fails safe: a missing module, an unsupported
// platform, or a denied permission all just mean no notification shows
// — never a thrown error a caller has to handle. A missed deposit alert
// is not worth crashing anything over.

import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

/**
 * Requests Android 13+'s POST_NOTIFICATIONS runtime permission. A no-op
 * (resolves true) on iOS and on Android below 13, where this permission
 * doesn't exist / is granted at install time. Safe to call more than
 * once — Android itself no-ops a re-request after the user has already
 * answered.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  try {
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/** Posts a local notification. Resolves false (never throws) if the module is unavailable, the permission isn't granted, or anything else goes wrong. */
export async function notify(title: string, body: string): Promise<boolean> {
  const native = NativeModules.LocalNotifyModule;
  if (!native || typeof native.notify !== 'function') return false;
  try {
    return Boolean(await native.notify(title, body));
  } catch {
    return false;
  }
}
