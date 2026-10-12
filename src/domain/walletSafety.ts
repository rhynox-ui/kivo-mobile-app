export function normalizeAddress(address: string): string { return address.trim(); }
export function hasAddress(address: string | null | undefined): boolean { return typeof address === 'string' && address.trim().length > 0; }
export function isEvmAddress(address: string): boolean { return /^0x[a-fA-F0-9]{40}$/.test(address.trim()); }
export function isSolanaAddress(address: string): boolean { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim()); }
export function neverAcceptSecret(value: unknown): never {
  throw new Error('Kivo never accepts seed phrases or private keys through this boundary.');
}
export function safeDisplayAddress(address: string, visible = 6): string {
  const value = normalizeAddress(address);
  if (value.length <= visible * 2 + 3) return value;
  return value.slice(0, visible) + '…' + value.slice(-visible);
}

export function sameAddress(a: string, b: string): boolean { return normalizeAddress(a).toLowerCase() === normalizeAddress(b).toLowerCase(); }

export function isSupportedWalletAddress(address: string): boolean {
  return isEvmAddress(address) || isSolanaAddress(address);
}
