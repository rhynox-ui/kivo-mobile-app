// Solana account from the same recovery phrase, at Mango Pro's path
// (m/44'/501'/0'/0'), so a phrase imported from Mango Pro shows the same
// Solana address. Uses the from-scratch SLIP-10 ed25519 derivation ported
// from Mango Pro (ed25519-hd-key needs Node's crypto, missing on Hermes).
import { mnemonicToSeedSync } from '@scure/bip39';
import { Keypair } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { derivePath } from './slip10Ed25519.ts';

export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export function deriveSolanaKeypair(mnemonic: string): Keypair {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seedHex = Buffer.from(mnemonicToSeedSync(normalized)).toString('hex');
  return Keypair.fromSeed(derivePath(SOLANA_DERIVATION_PATH, seedHex).key);
}
