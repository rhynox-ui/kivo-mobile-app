import * as bip39 from '@scure/bip39';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {derivePath} from './slip10Ed25519';

// The account shape Mango Pro's execution code expects. In Kivo it is built
// only inside a device-unlock callback and never stored.
export type ChainAccount = {address: string; privateKey: string};
export type AuthMethod = 'seed' | 'google';
export const NEAR_DERIVATION_PATH = "m/44'/397'/0'";
export type DerivedAccounts = {evm: ChainAccount; solana: ChainAccount; near?: ChainAccount; authMethod?: AuthMethod};
export function nearDerivationPathForIndex(index: number): string { return `m/44'/397'/${index}'`; }

/** Derive the implicit NEAR account and its ed25519 signing key from the same recovery phrase. */
export function deriveNearAccount(mnemonic: string, index = 0): ChainAccount {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const {key} = derivePath(nearDerivationPathForIndex(index), Buffer.from(seed).toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return {address: Buffer.from(keypair.publicKey.toBytes()).toString('hex'), privateKey: `ed25519:${bs58.encode(keypair.secretKey)}`};
}
