// One encrypted vault secret, two shapes:
//  - a BIP-39 recovery phrase (EVM + Solana + NEAR derived from it), or
//  - a bundle of imported private keys (one per network family).
// The vault encrypts whichever string serializeWalletSecret() returns, so
// existing phrase vaults keep working unchanged. Key bundles carry a prefix a
// recovery phrase can never start with.
import { validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { deriveSolanaKeypair } from './solanaKeys.ts';
import { deriveNearAccount } from '../../trading/wallet/keys.ts';
import { normalizeRecoveryPhrase } from './recoveryPhrase.ts';

const KEY_BUNDLE_PREFIX = 'kivo-keys:v1:';

export type KeyBundle = {
  /** 0x-prefixed secp256k1 key, shared by every EVM network. */
  evm: Hex;
  /** True when Kivo generated the EVM key because the user imported a non-EVM key only. */
  evmGenerated?: boolean;
  /** base58 64-byte Solana secret key. */
  solana?: string;
  /** NEAR key in `ed25519:<base58 64-byte secret>` form (implicit account). */
  near?: string;
};

export type WalletSecret = { kind: 'mnemonic'; mnemonic: string } | { kind: 'keys'; keys: KeyBundle };

export function serializeWalletSecret(secret: WalletSecret): string {
  return secret.kind === 'mnemonic' ? secret.mnemonic : KEY_BUNDLE_PREFIX + JSON.stringify(secret.keys);
}

export function parseWalletSecret(raw: string): WalletSecret {
  if (!raw.startsWith(KEY_BUNDLE_PREFIX)) return { kind: 'mnemonic', mnemonic: raw };
  const keys = JSON.parse(raw.slice(KEY_BUNDLE_PREFIX.length)) as KeyBundle;
  if (!keys || typeof keys.evm !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(keys.evm)) throw new Error('Stored wallet keys are invalid.');
  return { kind: 'keys', keys };
}

export function evmAccountFor(secret: WalletSecret): LocalAccount {
  return secret.kind === 'mnemonic' ? mnemonicToAccount(secret.mnemonic) : privateKeyToAccount(secret.keys.evm);
}

export function evmPrivateKeyFor(secret: WalletSecret): Hex {
  if (secret.kind === 'keys') return secret.keys.evm;
  const pk = mnemonicToAccount(secret.mnemonic).getHdKey().privateKey;
  if (!pk) throw new Error('The device wallet key is unavailable.');
  return bytesToHex(new Uint8Array(pk));
}

export function solanaKeypairFor(secret: WalletSecret): Keypair | null {
  if (secret.kind === 'mnemonic') return deriveSolanaKeypair(secret.mnemonic);
  return secret.keys.solana ? Keypair.fromSecretKey(bs58.decode(secret.keys.solana)) : null;
}

export function nearAccountFor(secret: WalletSecret): { address: string; privateKey: string } | null {
  if (secret.kind === 'mnemonic') return deriveNearAccount(secret.mnemonic);
  if (!secret.keys.near) return null;
  const bytes = bs58.decode(secret.keys.near.slice('ed25519:'.length));
  return { address: Buffer.from(bytes.slice(32)).toString('hex'), privateKey: secret.keys.near };
}

// ---------------------------------------------------------------------------
// Import detection: one field, the format decides the network. Every key is
// validated and its address derived locally; nothing is sent anywhere.

export type DetectedImport =
  | { status: 'empty' }
  | { status: 'incomplete' | 'invalid' | 'ambiguous'; message: string }
  | { status: 'ok'; kind: 'mnemonic'; label: string; secret: WalletSecret; addresses: { network: string; address: string }[] }
  | { status: 'ok'; kind: 'evm' | 'solana' | 'near'; label: string; secret: WalletSecret; addresses: { network: string; address: string }[]; generatesEvm: boolean };

const EVM_NETWORKS = 'Ethereum, Base, BNB Chain, Arbitrum and other EVM networks';

function ed25519Pair(secret64: Uint8Array): Keypair | null {
  if (secret64.length !== 64) return null;
  try {
    const pair = Keypair.fromSeed(secret64.slice(0, 32));
    // The stored public half must match the private half, or the key is corrupt/mistyped.
    return Buffer.from(pair.publicKey.toBytes()).equals(Buffer.from(secret64.slice(32))) ? pair : null;
  } catch {
    return null;
  }
}

function tryBase58(value: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  try { return bs58.decode(value); } catch { return null; }
}

/** `generateEvm` is injectable so detection stays deterministic in tests. */
export function detectImportInput(input: string, generateEvm: () => Hex = generatePrivateKey): DetectedImport {
  const value = input.trim();
  if (!value) return { status: 'empty' };

  // Recovery phrase: several lowercase words.
  const words = normalizeRecoveryPhrase(value.toLowerCase()).split(' ');
  if (words.length > 1) {
    if (!words.every(w => /^[a-z]+$/.test(w))) return { status: 'invalid', message: 'This looks like a recovery phrase but contains characters that are not words.' };
    if (words.length !== 12 && words.length !== 24) return { status: 'incomplete', message: `${words.length} words entered. Recovery phrases have 12 or 24 words.` };
    const mnemonic = words.join(' ');
    if (!validateMnemonic(mnemonic, english)) return { status: 'invalid', message: 'Recovery phrase is not valid. Check the words and their order.' };
    const secret: WalletSecret = { kind: 'mnemonic', mnemonic };
    const sol = solanaKeypairFor(secret);
    const near = nearAccountFor(secret);
    return {
      status: 'ok', kind: 'mnemonic', label: 'Recovery phrase · EVM, Solana and NEAR', secret,
      addresses: [
        { network: 'EVM', address: evmAccountFor(secret).address },
        ...(sol ? [{ network: 'Solana', address: sol.publicKey.toBase58() }] : []),
        ...(near ? [{ network: 'NEAR', address: near.address }] : []),
      ],
    };
  }

  // EVM private key: 32 bytes of hex, with or without 0x.
  const hex = value.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && (value.toLowerCase().startsWith('0x') || hex.length === 64)) {
    if (hex.length !== 64) return { status: 'incomplete', message: `EVM private keys are 64 hex characters; ${hex.length} entered.` };
    const key = `0x${hex.toLowerCase()}` as Hex;
    let address: string;
    try { address = privateKeyToAccount(key).address; } catch { return { status: 'invalid', message: 'This is not a valid EVM private key.' }; }
    return { status: 'ok', kind: 'evm', label: `EVM private key · ${EVM_NETWORKS}`, secret: { kind: 'keys', keys: { evm: key } }, addresses: [{ network: 'EVM', address }], generatesEvm: false };
  }

  // NEAR key: ed25519:<base58 secret>.
  if (/^ed25519:/i.test(value)) {
    const bytes = tryBase58(value.slice('ed25519:'.length));
    const pair = bytes && ed25519Pair(bytes);
    if (!pair) return { status: 'invalid', message: 'This NEAR key is not valid. Paste the full ed25519: secret key.' };
    const near = `ed25519:${bs58.encode(bytes!)}`;
    return withGeneratedEvm('near', 'NEAR private key · NEAR implicit account', { near }, [{ network: 'NEAR', address: Buffer.from(pair.publicKey.toBytes()).toString('hex') }], generateEvm);
  }

  // Solana key: JSON byte array (Solana CLI) or base58 (Phantom, Solflare).
  let solBytes: Uint8Array | null = null;
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value);
      if (Array.isArray(arr) && arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) solBytes = Uint8Array.from(arr);
    } catch { return { status: 'invalid', message: 'This looks like a Solana key file but is not valid JSON.' }; }
  } else {
    solBytes = tryBase58(value);
  }
  if (solBytes) {
    if (solBytes.length === 32) {
      return { status: 'ambiguous', message: 'This is a 32-byte key. It could belong to Solana or NEAR, and Kivo cannot tell which safely. Paste the full 64-byte Solana secret key, or a NEAR key starting with ed25519:.' };
    }
    const pair = ed25519Pair(solBytes);
    if (!pair) return { status: 'invalid', message: solBytes.length === 64 ? 'This Solana key does not match its public key. Check it was copied completely.' : 'This is not a recognised private key or recovery phrase.' };
    return withGeneratedEvm('solana', 'Solana private key · Solana', { solana: bs58.encode(solBytes) }, [{ network: 'Solana', address: pair.publicKey.toBase58() }], generateEvm);
  }

  return { status: 'invalid', message: 'Kivo does not recognise this format. Paste a 12/24-word recovery phrase, an EVM private key, a Solana private key or a NEAR ed25519: key.' };
}

// Kivo profiles sign in with an EVM account, so a Solana- or NEAR-only import
// gets a fresh EVM key alongside it. The UI discloses this before import, and
// the key can be backed up from Security › Export private keys.
function withGeneratedEvm(kind: 'solana' | 'near', label: string, partial: Omit<KeyBundle, 'evm'>, addresses: { network: string; address: string }[], generateEvm: () => Hex): DetectedImport {
  const evm = generateEvm();
  return {
    status: 'ok', kind, label, generatesEvm: true,
    secret: { kind: 'keys', keys: { ...partial, evm, evmGenerated: true } },
    addresses: [...addresses, { network: 'EVM (new, for your Kivo profile)', address: privateKeyToAccount(evm).address }],
  };
}

