// Proof that a Solana wallet is the home wallet of an EVM wallet, for
// Kivo's fee-free "move home" (EVM USDC -> the user's own USDC on Solana).
// Kivo's server only sponsors such a move without a fee when the Solana
// recipient really is this user's wallet (web/server/relay.ts
// ownsHomeWallet), so the device signs one plain-text message with the
// Solana key. The signature is public (it proves a link, it grants nothing)
// and is kept in memory for the session; the key never leaves the phone.

import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import type {DerivedAccounts} from '../wallet/keys';

/** Must match web/server/relay.ts homeMoveMessage. */
export function homeMoveMessage(evmAddress: string, solanaAddress: string): string {
  return `Kivo home: ${solanaAddress} is the Solana wallet of ${evmAddress.toLowerCase()}`;
}

const proofs = new Map<string, string>();
const keyOf = (evmAddress: string, solanaAddress: string) => `${evmAddress.toLowerCase()}:${solanaAddress}`;

/** A proof signed earlier this session, if any (lets a preview quote be sponsored without unlocking). */
export function cachedHomeProof(evmAddress: string, solanaAddress: string | undefined): string | undefined {
  return solanaAddress ? proofs.get(keyOf(evmAddress, solanaAddress)) : undefined;
}

/** Signs (or reuses) the proof with the unlocked accounts. Null when there is no Solana wallet. */
export function homeProofFor(accounts: DerivedAccounts): string | null {
  const evm = accounts.evm?.address;
  const solana = accounts.solana?.address;
  if (!evm || !solana || !accounts.solana.privateKey) return null;
  const cached = proofs.get(keyOf(evm, solana));
  if (cached) return cached;
  const secret = bs58.decode(accounts.solana.privateKey);
  const seed = secret.slice(0, 32);
  // The key must really be this Solana wallet's (a mismatch would sign for someone else's address).
  if (bs58.encode(ed25519.getPublicKey(seed)) !== solana) throw new Error('The unlocked Solana key does not match this wallet.');
  const proof = bs58.encode(ed25519.sign(new TextEncoder().encode(homeMoveMessage(evm, solana)), seed));
  proofs.set(keyOf(evm, solana), proof);
  return proof;
}

export function clearHomeProofs(): void {
  proofs.clear();
}
