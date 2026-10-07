// src/polyfills.ts
//
// Ported verbatim from mango-mobile's own src/polyfills.js — must be
// imported FIRST, before anything else (index.js does exactly that).
// Node-shaped globals the wallet crypto (bip39, viem, @solana/web3.js,
// bs58, src/wallet/walletCipher.ts) all expect, which Hermes doesn't
// provide out of the box:
//
// - react-native-get-random-values: polyfills crypto.getRandomValues
//   with the OS's real secure RNG (not simulated) — mnemonic generation
//   and vault salt/iv both depend on this being in place before they run.
// - buffer: polyfills the global `Buffer` the same libraries assume is
//   available, matching Node's/a bundler's own behavior.
// - TextEncoder/TextDecoder: Hermes has neither global. This gap only
//   shows up on a real device — Node (which every verify script and
//   typecheck runs under) has both natively, so it's invisible until an
//   actual phone hits `walletCipher.ts`'s decryptSecret. Implemented
//   directly on top of the Buffer polyfill above rather than pulling in
//   another package — encode/decode is just a UTF-8 round-trip through
//   Buffer, already present.
//
// structuredClone is deliberately NOT ported here — mobile's own comment
// on why it's needed there is specific to @coral-xyz/anchor's Launchpad
// SDK, which this app doesn't depend on yet. Add it if/when a dependency
// actually needs it, rather than polyfilling a gap nothing here has.

import 'react-native-get-random-values';
import {Buffer} from 'buffer';

(globalThis as any).Buffer = Buffer;

if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = class TextEncoder {
    encode(input = ''): Uint8Array {
      return new Uint8Array(Buffer.from(String(input), 'utf-8'));
    }
  };
}

if (typeof (globalThis as any).TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = class TextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (input === undefined) return '';
      return Buffer.from(input as ArrayBuffer).toString('utf-8');
    }
  };
}
