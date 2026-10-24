// How a Kivo account is named on screen, in both apps and in server texts.
//
// "@username" once the account has published a username on Kivo's server,
// otherwise its short wallet: "0xb283…38b5" (EVM) or "7xKX…sgAs" (Solana).
// Never the raw account id ("kivo:0x…") and never a generic "Kivo user".
// Keep this file identical in rhynox-ui/kivo and rhynox-ui/kivo-mobile-app.

import {shortWallet, walletAddressOfUserId} from '../api/types';

const EVM = /^0x[a-fA-F0-9]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const USERNAME = /^[A-Za-z0-9_]{3,32}$/;
/** The local placeholder a new phone/browser starts with ("kivo_b28314"); not a chosen name. */
const PLACEHOLDER = /^kivo_[a-z0-9]{6}$/i;

/**
 * A real, chosen username (without "@"), or null. Rejects empty values, the
 * local placeholder, and what older servers sent for a missing username
 * (the start of the account id, e.g. "kivo:0xb28314338b5", or a short wallet).
 */
export function publicUsername(username: string | null | undefined): string | null {
  const value = typeof username === 'string' ? username.trim().replace(/^@/, '') : '';
  if (!USERNAME.test(value) || PLACEHOLDER.test(value)) return null;
  return value;
}

/** True for the placeholder username an account starts with before choosing one. */
export function isPlaceholderUsername(username: string | null | undefined): boolean {
  return typeof username === 'string' && PLACEHOLDER.test(username.trim().replace(/^@/, ''));
}

/** "0xb283…38b5" / "7xKX…sgAs" from a wallet address or a Kivo account id; null when it is neither. */
export function shortWalletLabel(userIdOrAddress: string | null | undefined): string | null {
  if (typeof userIdOrAddress !== 'string') return null;
  const address = walletAddressOfUserId(userIdOrAddress.trim());
  if (EVM.test(address)) return shortWallet(address.toLowerCase());
  if (SOLANA.test(address)) return shortWallet(address);
  return null;
}

/** "@alice", or the short wallet when the account has no published username. */
export function userHandle(username: string | null | undefined, userIdOrAddress: string | null | undefined, fallback = 'Unknown'): string {
  const name = publicUsername(username);
  if (name) return '@' + name;
  return shortWalletLabel(userIdOrAddress) ?? fallback;
}

/** Like userHandle without the "@" (avatars' initials, plain labels). */
export function userPlainName(username: string | null | undefined, userIdOrAddress: string | null | undefined, fallback = 'Unknown'): string {
  return publicUsername(username) ?? shortWalletLabel(userIdOrAddress) ?? fallback;
}
