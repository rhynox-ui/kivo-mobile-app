import type {PublicKey, TransactionInstruction} from '@solana/web3.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS = new Set([0, 3]);
const TOKEN_CLOSE_ACCOUNT = 9;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Must match Kivo's sponsor server (web/server/solanaSponsor.ts): a classic
// SPL token account is 165 bytes; a Token-2022 associated token account is at
// least 170 (larger when the mint has account extensions, then measured by
// simulation). Rent-exempt minimum = (128 + size) x 6,960 lamports.
export const CLASSIC_TOKEN_ACCOUNT_SPACE = 165;
export const TOKEN_2022_ATA_MIN_SPACE = 170;
const MAX_TOKEN_ACCOUNT_SPACE = 400;
/** The sponsor funds at most this many new accounts per transaction (server rule). */
export const MAX_SPONSOR_FUNDED_CREATIONS = 3;

export function rentExemptLamports(space: number): number {
  return (128 + space) * 6960;
}

function isAtaCreate(ix: TransactionInstruction): boolean {
  return ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    && (ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1))
    && ix.keys.length >= 6;
}

function isSystemCreate(ix: TransactionInstruction): boolean {
  return ix.programId.toBase58() === SYSTEM_PROGRAM_ID && ix.data.length >= 4 && SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS.has(ix.data.readUInt32LE(0));
}

export function isTokenCloseAccount(ix: TransactionInstruction): boolean {
  const program = ix.programId.toBase58();
  return (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) && ix.data.length === 1 && ix.data[0] === TOKEN_CLOSE_ACCOUNT && ix.keys.length >= 3;
}

/** Token accounts an Associated Token Account Create/CreateIdempotent instruction in this list creates. */
export function associatedTokenAccountTargets(instructions: TransactionInstruction[]): string[] {
  return [...new Set(instructions.filter(isAtaCreate).map(ix => ix.keys[1].pubkey.toBase58()))];
}

/**
 * Lamports a System CreateAccount (tag 0) or CreateAccountWithSeed (tag 3)
 * instruction funds the new account with. WithSeed carries the lamports after
 * the base key and the variable-length seed: offset 4 + 32 + 8 + seed length.
 */
export function systemCreateLamports(ix: TransactionInstruction): number | null {
  if (!isSystemCreate(ix)) return null;
  const tag = ix.data.readUInt32LE(0);
  if (tag === 0) return ix.data.length >= 12 ? Number(ix.data.readBigUInt64LE(4)) : null;
  if (ix.data.length < 44) return null;
  const seedLength = Number(ix.data.readBigUInt64LE(36));
  const offset = 44 + seedLength;
  return ix.data.length >= offset + 8 ? Number(ix.data.readBigUInt64LE(offset)) : null;
}

/**
 * Rewrites account-creation funding to Kivo's sponsor before signing.
 *
 * `skipAccounts`: token accounts that already exist. Their (idempotent)
 * create is a no-op, so the user stays its payer: naming the sponsor would
 * make Kivo count rent the user must repay for an account nobody creates.
 */
export function rewriteAccountCreationFundingInstructions(
  instructions: TransactionInstruction[],
  feePayerPubkey: PublicKey,
  TransactionInstructionCtor: typeof import('@solana/web3.js').TransactionInstruction,
  options: {skipAccounts?: ReadonlySet<string>} = {},
): TransactionInstruction[] {
  return instructions.map(ix => {
    const programId = ix.programId.toBase58();
    const isAtaShape = programId === ASSOCIATED_TOKEN_PROGRAM_ID && (ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1));
    const hasExpectedAtaPayer = ix.keys.length >= 6 && ix.keys[0].isSigner && ix.keys[0].isWritable;
    const isAta = isAtaShape && hasExpectedAtaPayer;

    if (isAta) {
      const owner = ix.keys[2]?.pubkey;
      if (!owner) throw new Error('Refusing malformed Associated Token Account creation: owner account is missing.');
      if (owner.equals(feePayerPubkey)) {
        throw new Error('Refusing Associated Token Account creation owned by the sponsor fee payer.');
      }
      if (options.skipAccounts?.has(ix.keys[1].pubkey.toBase58())) return ix;
    }
    if (!isAta && !isSystemCreate(ix)) return ix;
    const keys = ix.keys.map((k, i) => (i === 0 ? {...k, pubkey: feePayerPubkey} : k));
    return new TransactionInstructionCtor({keys, programId: ix.programId, data: ix.data});
  });
}

/** Returns a copy of a token CloseAccount instruction sending the closed account's lamports to `destination`. */
export function withCloseDestination(
  ix: TransactionInstruction,
  destination: PublicKey,
  TransactionInstructionCtor: typeof import('@solana/web3.js').TransactionInstruction,
): TransactionInstruction {
  if (!isTokenCloseAccount(ix)) throw new Error('Not a token CloseAccount instruction.');
  const keys = ix.keys.map((k, i) => (i === 1 ? {...k, pubkey: destination, isWritable: true} : k));
  return new TransactionInstructionCtor({keys, programId: ix.programId, data: ix.data});
}

/**
 * What Kivo's sponsor server will require to be repaid in the same
 * transaction: the worst-case rent of every account the sponsor funds
 * (`feePayer` as funder), except accounts closed back to the sponsor
 * (`closedBack`). `measured` holds simulated lamports of Token-2022 accounts,
 * whose size depends on their mint. Pure, no network I/O.
 */
export function sponsorFundedRent(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  options: {closedBack?: ReadonlySet<string>; measured?: ReadonlyMap<string, number>} = {},
): {lamports: number; creations: number; accounts: string[]} {
  let lamports = 0;
  let creations = 0;
  const accounts: string[] = [];
  for (const ix of instructions) {
    if (!ix.keys[0]?.pubkey.equals(feePayer)) continue;
    let rent: number | null = null;
    let target: string | null = null;
    if (isAtaCreate(ix)) {
      target = ix.keys[1].pubkey.toBase58();
      if (ix.keys[5].pubkey.toBase58() === TOKEN_PROGRAM_ID) {
        rent = rentExemptLamports(CLASSIC_TOKEN_ACCOUNT_SPACE);
      } else {
        const minimum = rentExemptLamports(TOKEN_2022_ATA_MIN_SPACE);
        const simulated = options.measured?.get(target);
        rent = Math.max(minimum, Math.min(typeof simulated === 'number' ? simulated : 0, rentExemptLamports(MAX_TOKEN_ACCOUNT_SPACE)));
      }
    } else if (isSystemCreate(ix)) {
      target = ix.keys[1]?.pubkey.toBase58() ?? null;
      rent = systemCreateLamports(ix);
    }
    if (rent === null || target === null) continue;
    creations++;
    if (options.closedBack?.has(target)) continue;
    lamports += rent;
    accounts.push(target);
  }
  return {lamports, creations, accounts};
}

/** Token-2022 associated token accounts the sponsor funds: their rent is read from a simulation. */
export function sponsorFundedToken2022Accounts(instructions: TransactionInstruction[], feePayer: PublicKey): string[] {
  return [...new Set(instructions
    .filter(ix => isAtaCreate(ix) && ix.keys[0].pubkey.equals(feePayer) && ix.keys[5].pubkey.toBase58() !== TOKEN_PROGRAM_ID)
    .map(ix => ix.keys[1].pubkey.toBase58()))];
}

/**
 * New WSOL token accounts this transaction creates for `owner` with the
 * sponsor paying: the only accounts Kivo may close back to its sponsor.
 */
export function sponsorFundedWsolAccounts(instructions: TransactionInstruction[], feePayer: PublicKey, owner: PublicKey): string[] {
  return [...new Set(instructions
    .filter(ix => isAtaCreate(ix) && ix.keys[0].pubkey.equals(feePayer) && ix.keys[2].pubkey.equals(owner) && ix.keys[3].pubkey.toBase58() === WSOL_MINT && ix.keys[5].pubkey.toBase58() === TOKEN_PROGRAM_ID)
    .map(ix => ix.keys[1].pubkey.toBase58()))];
}

/** A token account's `amount` (u64 at byte 64 of its data). */
export function tokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) return null;
  let value = 0n;
  for (let i = 71; i >= 64; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}
