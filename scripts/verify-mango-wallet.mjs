import assert from 'node:assert/strict';
import {mnemonicToAccount} from 'viem/accounts';
import {deriveSolanaKeypair, SOLANA_DERIVATION_PATH} from '../src/wallet/solanaKeys.ts';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const evm = mnemonicToAccount(mnemonic);
assert.equal(evm.address.toLowerCase(), '0x9858effd232b4033e47d90003d41ec34ecaeda94');
const a = deriveSolanaKeypair(mnemonic).publicKey.toBase58();
const b = deriveSolanaKeypair(mnemonic).publicKey.toBase58();
assert.equal(a, b);
assert.equal(SOLANA_DERIVATION_PATH, "m/44'/501'/0'/0'");
console.log('ok - EVM BIP-44 known vector');
console.log('ok - Solana derivation deterministic');
console.log('ok - Solana derivation path matches Mango Pro');
console.log('\nWallet parity gate: 3 checks passed');
