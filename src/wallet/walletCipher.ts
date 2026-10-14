import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

export const PBKDF2_ITERATIONS = 600_000;

export type SecretRecord = {
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

const MIN_ACCEPTED_ITERATIONS = 50_000;
const MAX_ACCEPTED_ITERATIONS = 5_000_000;
const EXPECTED_SALT_BYTES = 16;
const EXPECTED_IV_BYTES = 12;
const MIN_CIPHERTEXT_BYTES = 16;

function decodedLength(value: unknown, field: string): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Vault record is malformed: ${field} is missing.`);
  }

  let bytes: Uint8Array;
  try {
    bytes = unb64(value);
  } catch {
    throw new Error(`Vault record is malformed: ${field} is not valid base64.`);
  }

  return bytes.length;
}

export function assertValidSecretRecord(record: unknown): asserts record is SecretRecord {
  if (!record || typeof record !== 'object') {
    throw new Error('Vault record is malformed: not an object.');
  }

  const { iterations } = record as SecretRecord;
  if (!Number.isInteger(iterations)) {
    throw new Error('Vault record is malformed: iterations is not an integer.');
  }
  if (iterations < MIN_ACCEPTED_ITERATIONS || iterations > MAX_ACCEPTED_ITERATIONS) {
    throw new Error(`Vault record is malformed: iterations ${iterations} is outside the accepted range.`);
  }
  if (decodedLength((record as SecretRecord).salt, 'salt') !== EXPECTED_SALT_BYTES) {
    throw new Error(`Vault record is malformed: salt is not ${EXPECTED_SALT_BYTES} bytes.`);
  }
  if (decodedLength((record as SecretRecord).iv, 'iv') !== EXPECTED_IV_BYTES) {
    throw new Error(`Vault record is malformed: iv is not ${EXPECTED_IV_BYTES} bytes.`);
  }
  if (decodedLength((record as SecretRecord).ciphertext, 'ciphertext') < MIN_CIPHERTEXT_BYTES) {
    throw new Error('Vault record is malformed: ciphertext is too short.');
  }
}

export function derivePureJsAesKeyBytes(
  password: string,
  saltBytes: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  return pbkdf2Async(sha256, new TextEncoder().encode(password), saltBytes, {
    c: iterations,
    dkLen: 32,
  });
}

export function encryptWithKeyBytes(
  secret: string,
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
): Uint8Array {
  return gcm(keyBytes, ivBytes).encrypt(new TextEncoder().encode(secret));
}

export function decryptWithKeyBytes(
  ciphertextBytes: Uint8Array,
  keyBytes: Uint8Array,
  ivBytes: Uint8Array,
): string {
  try {
    return new TextDecoder().decode(gcm(keyBytes, ivBytes).decrypt(ciphertextBytes));
  } catch {
    throw new Error('Incorrect password.');
  }
}

