import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PBKDF2_ITERATIONS,
  assertValidSecretRecord,
  derivePureJsAesKeyBytes,
  encryptWithKeyBytes,
  decryptWithKeyBytes,
  type SecretRecord,
} from './walletCipher';
import { tryNativePbkdf2Sha256 } from './nativePbkdf2';
import { checkPasswordPolicy } from './passwordPolicy';
import { getLockoutStatus, recordFailedAttempt, recordSuccessfulUnlock } from './unlockAttempts';

const SERVICE = 'com.kivo.chat.vault';
const USERNAME = 'kivo-vault';
const LEGACY_SERVICE = 'com.kivo.chat.wallet';
const STORAGE_KEY = 'kivo_wallet_vault_v1';
const VAULT_SCHEMA_VERSION = 2;

type StoredVault = { version: number; mnemonicRecord: SecretRecord };

function b64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64');
}

function unb64(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  return (await tryNativePbkdf2Sha256(password, salt, iterations, 32))
    ?? (await derivePureJsAesKeyBytes(password, salt, iterations));
}

export class VaultLockedError extends Error {
  remainingMs: number;

  constructor(ms: number) {
    super(`Too many incorrect attempts. Try again in ${Math.ceil(ms / 1000)}s.`);
    this.remainingMs = ms;
    this.name = 'VaultLockedError';
  }
}

/** A wallet may exist; a Keychain read failure must never look like no wallet. */
export class VaultUnavailableError extends Error {
  constructor() {
    super('Kivo could not read wallet storage on this device. Close and reopen Kivo to try again. Your wallet has not been changed.');
    this.name = 'VaultUnavailableError';
  }
}

/** Stored wallet data exists but could not be safely validated; never overwrite it automatically. */
export class VaultCorruptError extends Error {
  constructor() {
    super('Kivo found wallet data it could not safely validate. Your wallet has not been changed. Do not create another wallet on this device; use your recovery phrase or contact Kivo support.');
    this.name = 'VaultCorruptError';
  }
}

export async function encryptSecret(secret: string, password: string): Promise<SecretRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, PBKDF2_ITERATIONS);
  return {
    iterations: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(encryptWithKeyBytes(secret, key, iv)),
  };
}

export async function decryptSecret(record: SecretRecord, password: string): Promise<string> {
  assertValidSecretRecord(record);
  const key = await derive(password, unb64(record.salt), record.iterations);
  return decryptWithKeyBytes(unb64(record.ciphertext), key, unb64(record.iv));
}

export async function createVault(mnemonic: string, password: string) {
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    throw new Error('Password must be at least 14 characters and not be a common or predictable password.');
  }

  // The service is dedicated to this wallet vault. Any existing credential
  // means data is already present; only clearVault() may remove it.
  let existing: false | { password: string };
  try {
    existing = await Keychain.getGenericPassword({ service: SERVICE });
  } catch {
    throw new VaultUnavailableError();
  }
  if (existing) {
    throw new Error('Wallet data is already stored on this device. Unlock it, or explicitly remove it in Settings before creating or importing another.');
  }

  const mnemonicRecord = await encryptSecret(mnemonic, password);
  assertValidSecretRecord(mnemonicRecord);
  const payload = JSON.stringify({ version: VAULT_SCHEMA_VERSION, mnemonicRecord });
  await Keychain.setGenericPassword(USERNAME, payload, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VAULT_SCHEMA_VERSION }));
  await clearLegacyWallet();
}

export async function loadVault(): Promise<StoredVault | null> {
  let credential: false | { password: string };
  try {
    credential = await Keychain.getGenericPassword({ service: SERVICE });
  } catch {
    throw new VaultUnavailableError();
  }

  if (credential) {
    if (typeof credential.password !== 'string') throw new VaultCorruptError();

    let stored: { version?: number; mnemonicRecord?: SecretRecord };
    try {
      stored = JSON.parse(credential.password);
    } catch {
      throw new VaultCorruptError();
    }

    if (stored?.version === VAULT_SCHEMA_VERSION && stored.mnemonicRecord) {
      try {
        assertValidSecretRecord(stored.mnemonicRecord);
      } catch {
        throw new VaultCorruptError();
      }
      return { version: VAULT_SCHEMA_VERSION, mnemonicRecord: stored.mnemonicRecord };
    }

    if (stored?.version === 1 && stored.mnemonicRecord) {
      try {
        assertValidSecretRecord(stored.mnemonicRecord);
        await createVersion2Record(stored.mnemonicRecord);
      } catch {
        throw new VaultCorruptError();
      }
      return { version: VAULT_SCHEMA_VERSION, mnemonicRecord: stored.mnemonicRecord };
    }

    throw new VaultCorruptError();
  }

  let rawMarker: string | null;
  try {
    rawMarker = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    throw new VaultUnavailableError();
  }
  if (!rawMarker) return null;

  let marker: { version?: number };
  try {
    marker = JSON.parse(rawMarker);
  } catch {
    throw new VaultCorruptError();
  }

  // A v2 marker without a Keychain credential is inconsistent. A v1 marker
  // can be migrated from the old record format, but every other state fails closed.
  if (marker?.version !== 1) throw new VaultCorruptError();

  let legacy: false | { password: string };
  try {
    legacy = await Keychain.getGenericPassword({ service: SERVICE });
  } catch {
    throw new VaultUnavailableError();
  }
  if (!legacy || typeof legacy.password !== 'string') throw new VaultCorruptError();

  let parsed: { mnemonicRecord?: SecretRecord };
  try {
    parsed = JSON.parse(legacy.password);
    if (!parsed?.mnemonicRecord) throw new Error('Missing wallet record');
    assertValidSecretRecord(parsed.mnemonicRecord);
    await createVersion2Record(parsed.mnemonicRecord);
  } catch {
    throw new VaultCorruptError();
  }

  return { version: VAULT_SCHEMA_VERSION, mnemonicRecord: parsed.mnemonicRecord! };
}

async function createVersion2Record(mnemonicRecord: SecretRecord) {
  const payload = JSON.stringify({ version: VAULT_SCHEMA_VERSION, mnemonicRecord });
  await Keychain.setGenericPassword(USERNAME, payload, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VAULT_SCHEMA_VERSION }));
}

export async function hasVault() {
  return Boolean(await loadVault());
}

export async function clearVault() {
  await Keychain.resetGenericPassword({ service: SERVICE });
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function unlockVaultMnemonic(vault: StoredVault, password: string) {
  const status = await getLockoutStatus();
  if (status.locked) throw new VaultLockedError(status.remainingMs);

  try {
    const mnemonic = await decryptSecret(vault.mnemonicRecord, password);
    await recordSuccessfulUnlock();
    return mnemonic;
  } catch (error) {
    await recordFailedAttempt();
    throw error;
  }
}

export async function getLegacyMnemonic(): Promise<string | null> {
  try {
    const credential = await Keychain.getGenericPassword({ service: LEGACY_SERVICE });
    return credential ? credential.password : null;
  } catch {
    return null;
  }
}

export async function clearLegacyWallet() {
  await Keychain.resetGenericPassword({ service: LEGACY_SERVICE }).catch(() => {});
}
