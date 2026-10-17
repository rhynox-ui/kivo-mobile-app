// "Continue with Google": the wallet's recovery phrase, encrypted on this
// device with the user's Kivo password, saved to a hidden app folder in the
// user's OWN Google Drive (appDataFolder: only Kivo can see it, it never shows
// in their Drive files). A new phone restores it with Google sign-in plus the
// same password. Nothing is sent to Kivo's servers and no wallet provider is
// involved, so there is no per-user cost.
//
// Security model:
//  - Google access alone is not enough: the backup is AES-encrypted with a key
//    stretched from the Kivo password (PBKDF2-SHA256, 600k iterations, the same
//    as the on-device vault), and passwords must pass passwordPolicy (14+ chars).
//  - Kivo alone has nothing: the file lives in the user's Drive.
//  - The phrase can still be revealed and written down from Settings.

import { GoogleSignin, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { decryptSecret, encryptSecret } from './vault';
import { assertValidSecretRecord, type SecretRecord } from './walletCipher';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'kivo-wallet-backup.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TIMEOUT_MS = 20_000;

/** Optional: only needed if Kivo ever wants Google ID tokens; Drive access works without it on Android. */
const GOOGLE_WEB_CLIENT_ID: string | undefined = undefined;

export type GoogleAccount = { email: string; name: string | null; accessToken: string };
export type WalletBackup = { version: 1; kind: 'kivo-wallet-backup'; createdAt: number; evmAddress: string; record: SecretRecord };

export class GoogleSignInCancelled extends Error {
  constructor() { super('Google sign-in was cancelled.'); this.name = 'GoogleSignInCancelled'; }
}

let configured = false;
function configure() {
  if (configured) return;
  GoogleSignin.configure({ scopes: [DRIVE_SCOPE], ...(GOOGLE_WEB_CLIENT_ID ? { webClientId: GOOGLE_WEB_CLIENT_ID } : {}) });
  configured = true;
}

/** Signs in with Google and returns a Drive token limited to Kivo's hidden app folder. */
export async function signInWithGoogle(): Promise<GoogleAccount> {
  configure();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) throw new GoogleSignInCancelled();
    if (!response.data.scopes.includes(DRIVE_SCOPE)) {
      const granted = await GoogleSignin.addScopes({ scopes: [DRIVE_SCOPE] });
      if (!granted) throw new Error('Kivo needs access to its own backup folder in your Google Drive to save your wallet.');
    }
    const { accessToken } = await GoogleSignin.getTokens();
    return { email: response.data.user.email, name: response.data.user.name, accessToken };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (error instanceof GoogleSignInCancelled || code === statusCodes.SIGN_IN_CANCELLED) throw new GoogleSignInCancelled();
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) throw new Error('Google Play services are not available on this phone. Use a recovery phrase instead.');
    if (code === statusCodes.IN_PROGRESS) throw new Error('Google sign-in is already open.');
    throw error instanceof Error ? error : new Error('Google sign-in failed.');
  }
}

export async function signOutOfGoogle(): Promise<void> {
  configure();
  await GoogleSignin.signOut().catch(() => {});
}

async function drive(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new Error('Google Drive refused access. Sign in with Google again.');
    if (!response.ok) throw new Error(`Google Drive did not answer (HTTP ${response.status}). Try again.`);
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Google Drive took too long to answer. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findBackupFile(token: string): Promise<string | null> {
  const query = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
  const response = await drive(`${DRIVE}/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime desc&fields=files(id,modifiedTime)`, token);
  const body = await response.json() as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

function parseBackup(value: unknown): WalletBackup {
  const backup = value as Partial<WalletBackup> | null;
  if (!backup || backup.kind !== 'kivo-wallet-backup' || backup.version !== 1 || typeof backup.evmAddress !== 'string') throw new Error('The Kivo backup in your Google Drive is not readable.');
  assertValidSecretRecord(backup.record);
  return backup as WalletBackup;
}

/** The encrypted wallet backup in this Google account, or null when there is none yet. */
export async function readBackup(account: GoogleAccount): Promise<WalletBackup | null> {
  const id = await findBackupFile(account.accessToken);
  if (!id) return null;
  const response = await drive(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, account.accessToken);
  return parseBackup(await response.json());
}

/** Encrypts the recovery phrase with the Kivo password and saves it (replacing any previous backup). */
export async function writeBackup(account: GoogleAccount, mnemonic: string, password: string, evmAddress: string): Promise<void> {
  const backup: WalletBackup = { version: 1, kind: 'kivo-wallet-backup', createdAt: Date.now(), evmAddress, record: await encryptSecret(mnemonic, password) };
  // Prove the backup opens with this password before it replaces anything.
  if (await decryptSecret(backup.record, password) !== mnemonic) throw new Error('The backup could not be verified. Nothing was saved.');
  const existing = await findBackupFile(account.accessToken);
  const boundary = 'kivo' + Date.now().toString(36);
  const metadata = existing ? { name: FILE_NAME } : { name: FILE_NAME, parents: ['appDataFolder'] };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(backup)}\r\n--${boundary}--`;
  await drive(existing ? `${UPLOAD}/files/${encodeURIComponent(existing)}?uploadType=multipart` : `${UPLOAD}/files?uploadType=multipart`, account.accessToken, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** Opens a backup with the Kivo password. A wrong password throws; nothing is changed. */
export async function openBackup(backup: WalletBackup, password: string): Promise<string> {
  try {
    return await decryptSecret(backup.record, password);
  } catch {
    throw new Error('That password does not open this backup. Use the Kivo password you set when you created the wallet.');
  }
}
