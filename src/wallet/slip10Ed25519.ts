// src/wallet/slip10Ed25519.ts
//
// Ported verbatim (typed) from mango-mobile's own src/wallet/
// slip10Ed25519.js — pure-JS SLIP-0010 ed25519 hardened-only HD
// derivation. Not using the `ed25519-hd-key` npm package because it
// calls Node's `crypto.createHmac`, which doesn't exist under Hermes —
// Metro doesn't polyfill Node core modules the way webpack used to. This
// reimplements the same algorithm with @noble/hashes (pure JS, no
// native/Node dependency, audited, already what viem/ethers build on),
// so it runs identically under Hermes with no native module required.
//
// Independently verified byte-for-byte against the real `ed25519-hd-key`
// package's output for the standard BIP-39 test mnemonic in
// mango-mobile's own scripts/verify-wallet-crypto.mjs — this is the same
// algorithm, unchanged. Never touch this file without re-running that
// check (or an equivalent one here).

import {hmac} from '@noble/hashes/hmac.js';
import {sha512} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from '@noble/hashes/utils.js';

const ED25519_CURVE = utf8ToBytes('ed25519 seed');
const HARDENED_OFFSET = 0x80000000;

export type Slip10Node = {key: Uint8Array; chainCode: Uint8Array};

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** Master key from a BIP-39 seed (hex string), matching ed25519-hd-key's getMasterKeyFromSeed. */
export function getMasterKeyFromSeed(seedHex: string): Slip10Node {
  const seed = hexToBytes(seedHex);
  const digest = hmacSha512(ED25519_CURVE, seed);
  return {key: digest.slice(0, 32), chainCode: digest.slice(32)};
}

function ckdPriv({key, chainCode}: Slip10Node, index: number): Slip10Node {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);
  const data = new Uint8Array(1 + key.length + indexBytes.length);
  data[0] = 0; // hardened derivation only — 0x00 || parent private key || index
  data.set(key, 1);
  data.set(indexBytes, 1 + key.length);
  const digest = hmacSha512(chainCode, data);
  return {key: digest.slice(0, 32), chainCode: digest.slice(32)};
}

/** path like "m/44'/501'/0'/0'" — every segment must be hardened ('), same restriction ed25519-hd-key enforces (ed25519 SLIP-0010 has no non-hardened child derivation). */
export function derivePath(path: string, seedHex: string): Slip10Node {
  if (!/^m(\/\d+')+$/.test(path)) {
    throw new Error(`Invalid derivation path "${path}" — every segment must be hardened (e.g. m/44'/501'/0'/0').`);
  }
  const segments = path
    .split('/')
    .slice(1)
    .map(seg => parseInt(seg.slice(0, -1), 10));
  let node = getMasterKeyFromSeed(seedHex);
  for (const index of segments) {
    node = ckdPriv(node, index + HARDENED_OFFSET);
  }
  return node;
}
