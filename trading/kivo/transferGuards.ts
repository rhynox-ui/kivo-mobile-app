// Pure checks for the mobile Send sheet: recipient address format, which
// assets may go to it, what Kivo's gas sponsor will cover, and destinations
// that would lose funds. Kept free of React so scripts can verify them.
import {isAddress} from 'viem';
import bs58 from 'bs58';
import {ed25519} from '@noble/curves/ed25519.js';
import {TOKEN_ADDRESSES} from '../core/chainData.ts';

export type AddressCheck = {ok: true; family: 'evm' | 'solana'; address: string} | {ok: false; problem: string | null};

function isOnCurve(bytes: Uint8Array): boolean {
  try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}

/**
 * Classifies a pasted recipient address as it is typed. EVM addresses must
 * match their EIP-55 checksum when mixed-case; Solana addresses must decode to
 * 32 bytes on the ed25519 curve (a wallet, not a program-derived account).
 */
export function checkRecipientAddress(raw: string): AddressCheck {
  const value = raw.trim();
  if (!value) return {ok: false, problem: null};
  if (/^0x/i.test(value)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return {ok: false, problem: 'An EVM address is 0x followed by 40 hex characters. Check that you pasted all of it.'};
    if (!isAddress(value)) return {ok: false, problem: 'This EVM address fails its checksum, so it may have a typo. Copy it again from the recipient.'};
    return {ok: true, family: 'evm', address: value};
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return {ok: false, problem: 'Paste a wallet address: 0x… for EVM networks, or a Solana address.'};
  let bytes: Uint8Array;
  try { bytes = bs58.decode(value); } catch { return {ok: false, problem: 'This is not a valid Solana address.'}; }
  if (bytes.length !== 32) return {ok: false, problem: 'This is not a valid Solana address. Check that you pasted all of it.'};
  if (!isOnCurve(bytes)) return {ok: false, problem: 'This Solana address is a program or token account, not a wallet. Ask the recipient for their wallet address.'};
  return {ok: true, family: 'solana', address: value};
}

/** Why an asset cannot go to an address of `family`. */
export function chainMismatchReason(assetChain: string, family: 'evm' | 'solana'): string | null {
  const assetIsSolana = assetChain === 'solana';
  if (assetIsSolana && family === 'evm') return 'This is a Solana token — paste a Solana wallet address';
  if (!assetIsSolana && family === 'solana') return 'This is an EVM token — paste a 0x… wallet address';
  return null;
}

/** Smallest EVM transfer Kivo's gas sponsor accepts. */
export const MIN_SPONSORED_EVM_USDC = 1;

/**
 * Kivo pays EVM gas only for a USDC transfer of at least 1 USDC (no native
 * coin, no other token). Returns why an EVM asset can't be sent, or null.
 */
export function evmSponsorReason(asset: {chainKey: string; address: string; kind: string}, amount?: number): string | null {
  if (asset.chainKey === 'solana') return null;
  const usdc = (TOKEN_ADDRESSES.USDC as Record<string, string | undefined> | undefined)?.[asset.chainKey];
  if (asset.kind === 'native' || !usdc || usdc.toLowerCase() !== asset.address.toLowerCase()) {
    return 'Kivo covers gas on EVM networks for USDC only, so this asset cannot be sent from Kivo yet';
  }
  if (amount !== undefined && amount < MIN_SPONSORED_EVM_USDC) return `Send at least ${MIN_SPONSORED_EVM_USDC} USDC on EVM networks (Kivo covers the gas from 1 USDC)`;
  return null;
}

const EVM_ZERO = '0x0000000000000000000000000000000000000000';
const SOLANA_NON_WALLETS = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]);
export const TOKEN_PROGRAM_OWNERS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

/** Why a destination must not receive this transfer (self, zero, token contract or mint), or null. */
export function blockedDestinationReason(input: {to: string; family: 'evm' | 'solana'; ownAddresses: Array<string | null | undefined>; tokenAddress?: string | null}): string | null {
  const to = input.to.trim();
  const same = (a: string | null | undefined) => Boolean(a) && (input.family === 'evm' ? a!.toLowerCase() === to.toLowerCase() : a === to);
  if (input.family === 'evm' && to.toLowerCase() === EVM_ZERO) return 'That is the zero address. Tokens sent there are burned.';
  if (input.ownAddresses.some(same)) return 'That is your own wallet. Choose another recipient.';
  if (input.tokenAddress && same(input.tokenAddress)) return input.family === 'solana' ? 'That is the token mint address, not a wallet. Tokens sent there are lost.' : 'That is the token contract, not a wallet. Tokens sent there are lost.';
  if (input.family === 'solana' && SOLANA_NON_WALLETS.has(to)) return 'That is a Solana program or mint address, not a wallet.';
  for (const byChain of Object.values(TOKEN_ADDRESSES)) {
    for (const [chain, address] of Object.entries(byChain ?? {})) {
      if (typeof address !== 'string') continue;
      if (input.family === 'evm' && address.startsWith('0x') && address.toLowerCase() === to.toLowerCase()) return 'That is a token contract, not a wallet. Tokens sent there are lost.';
      if (input.family === 'solana' && chain === 'solana' && address === to) return 'That is a token mint address, not a wallet. Tokens sent there are lost.';
    }
  }
  return null;
}

/** A fraction of a base-unit balance, rounded down so Max never exceeds the balance. */
export function fractionOf(raw: bigint, numerator: number, denominator = 100): bigint {
  if (raw <= 0n) return 0n;
  return raw * BigInt(numerator) / BigInt(denominator);
}

/** SOL that Max keeps back so the account stays rent-exempt. */
export const SOLANA_MAX_RESERVE_LAMPORTS = 890_880n + 15_000n;
