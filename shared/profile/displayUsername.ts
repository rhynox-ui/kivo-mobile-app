/** Centralized public display-name fallback for feed identities. */
export type DisplayIdentity = {
  displayName?: string | null;
  username?: string | null;
  walletAddress?: string | null;
  userId?: string | null;
  /** True when a profile row exists, even if it has no claimed username. */
  profileExists?: boolean;
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSyntheticUsername(value: string): boolean {
  return /^kivo_[a-z0-9]{6}$/i.test(value) || /^kivo:/i.test(value);
}

function shortWallet(value: string): string | null {
  const wallet = value.trim().replace(/^kivo:(?:sol:)?/i, '');
  if (/^0x[a-f\d]{40}$/i.test(wallet)) return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
  return null;
}

/** Prefer a real display name, then a real username, then a shortened wallet. */
export function getDisplayUsername(user: DisplayIdentity): string {
  const displayName = clean(user.displayName);
  if (displayName) return displayName;

  const username = clean(user.username).replace(/^@/, '');
  if (username && !isSyntheticUsername(username)) return `@${username}`;

  // A known profile with no claimed public name must not be represented by its wallet.
  if (user.profileExists) return 'Anonymous';

  const wallet = clean(user.walletAddress) || clean(user.userId);
  return shortWallet(wallet) ?? 'Anonymous';
}
