/** Normalize recovery phrase input consistently before BIP-39 validation. */
export function normalizeRecoveryPhrase(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Match a recovery word by its zero-based position, ignoring case and extra spacing. */
export function recoveryWordMatches(mnemonic: string, index: number, value: string): boolean {
  return mnemonic.trim().split(/\s+/)[index]?.toLowerCase() === value.trim().toLowerCase();
}
