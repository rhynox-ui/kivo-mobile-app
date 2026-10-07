import type { KeyValueStorage } from '../storage';
import { validBio, validProfileUsername } from '../social/validation';

/**
 * A Kivo profile is public display data attached to a wallet session.
 *
 * Identity rules shared by web and mobile:
 * - `userId` is derived from the wallet address the session controls.
 * - Username, avatar, bio, badges and reputation are display data only.
 *   They are never evidence that someone owns a wallet; only the live
 *   wallet session (browser provider account / device key) is.
 */
export type KivoProfile = {
  userId: string;
  username: string;
  bio: string;
  avatarUri?: string;
  walletAddress: string | null;
  createdAt: number;
  updatedAt: number;
};

export const GUEST_USER_ID = 'kivo:guest';
const STORAGE_PREFIX = 'kivo:profile:v1:';

export function profileUserIdForWallet(address: string | null | undefined): string {
  return address ? 'kivo:' + address.trim().toLowerCase() : GUEST_USER_ID;
}

export function defaultUsernameFor(address: string | null | undefined): string {
  return address ? 'kivo_' + address.trim().toLowerCase().slice(2, 8) : 'guest';
}

function freshProfile(address: string | null): KivoProfile {
  const now = Date.now();
  return { userId: profileUserIdForWallet(address), username: defaultUsernameFor(address), bio: '', walletAddress: address, createdAt: now, updatedAt: now };
}

let storage: KeyValueStorage | null = null;
let profile: KivoProfile = freshProfile(null);
const listeners = new Set<(value: KivoProfile) => void>();
let onChange: ((value: KivoProfile) => void) | null = null;

function emit() {
  const snapshot = getProfile();
  listeners.forEach(listener => listener(snapshot));
  onChange?.(snapshot);
}

export function configureProfileStore(options: { storage?: KeyValueStorage; onChange?: (value: KivoProfile) => void }) {
  if (options.storage) storage = options.storage;
  if (options.onChange) onChange = options.onChange;
}

/** Switches the active profile to the one attached to `address` (or the guest profile), loading any saved copy. */
export async function activateProfileForWallet(address: string | null): Promise<KivoProfile> {
  const normalized = address ? address.trim() : null;
  let next = freshProfile(normalized);
  if (normalized && storage) {
    try {
      const raw = await storage.getItem(STORAGE_PREFIX + normalized.toLowerCase());
      if (raw) {
        const saved = JSON.parse(raw) as Partial<KivoProfile>;
        next = {
          ...next,
          username: typeof saved.username === 'string' && validProfileUsername(saved.username) ? saved.username : next.username,
          bio: typeof saved.bio === 'string' && validBio(saved.bio) ? saved.bio : '',
          avatarUri: typeof saved.avatarUri === 'string' ? saved.avatarUri : undefined,
          createdAt: typeof saved.createdAt === 'number' ? saved.createdAt : next.createdAt,
          updatedAt: typeof saved.updatedAt === 'number' ? saved.updatedAt : next.updatedAt,
        };
      }
    } catch {
      // Unreadable cache: fall back to a fresh profile for this wallet.
    }
  }
  profile = next;
  emit();
  return getProfile();
}

export function getProfile(): KivoProfile {
  return { ...profile };
}

export function subscribeToProfile(listener: (value: KivoProfile) => void) {
  listeners.add(listener);
  listener(getProfile());
  return () => { listeners.delete(listener); };
}

export function updateProfile(input: { username: string; bio: string; avatarUri?: string }): KivoProfile {
  const walletAddress = profile.walletAddress;
  if (!walletAddress) throw new Error('Connect a wallet before editing your Kivo profile.');
  const username = input.username.trim().replace(/^@/, '').toLowerCase();
  const bio = input.bio.trim();
  if (!validProfileUsername(username)) throw new Error('Username must be 3–32 characters using letters, numbers or underscores.');
  if (!validBio(bio)) throw new Error('Bio must be 160 characters or fewer without control characters.');
  if (input.avatarUri != null && !isSafeAvatarUri(input.avatarUri)) throw new Error('Avatar must be an https image link or a small uploaded image.');
  profile = { ...profile, username, bio, avatarUri: input.avatarUri || undefined, updatedAt: Date.now() };
  if (storage) {
    const { userId: _userId, walletAddress: _wallet, ...persisted } = profile;
    void Promise.resolve(storage.setItem(STORAGE_PREFIX + walletAddress.toLowerCase(), JSON.stringify(persisted))).catch(() => {});
  }
  emit();
  return getProfile();
}

const MAX_AVATAR_DATA_URI_LENGTH = 400_000;
export function isSafeAvatarUri(uri: string): boolean {
  if (!uri) return true;
  if (/^https:\/\/[^\s"'<>]+$/i.test(uri)) return true;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(uri)) return uri.length <= MAX_AVATAR_DATA_URI_LENGTH;
  if (/^(file|content|ph):\/\//.test(uri)) return true;
  return false;
}
