import type {PublicKey, TransactionInstruction} from '@solana/web3.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS = new Set([0, 3]);

/** Rewrites account-creation funding to Kivo's sponsor before signing. */
export function rewriteAccountCreationFundingInstructions(
  instructions: TransactionInstruction[],
  feePayerPubkey: PublicKey,
  TransactionInstructionCtor: typeof import('@solana/web3.js').TransactionInstruction,
): TransactionInstruction[] {
  return instructions.map(ix => {
    const programId = ix.programId.toBase58();
    const isAtaCreate = ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1);
    const hasExpectedAtaPayer = ix.keys.length >= 6 && ix.keys[0].isSigner && ix.keys[0].isWritable;
    const isAta = programId === ASSOCIATED_TOKEN_PROGRAM_ID && isAtaCreate && hasExpectedAtaPayer;
    const isSystemCreate = programId === SYSTEM_PROGRAM_ID && ix.data.length >= 4 && SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS.has(ix.data.readUInt32LE(0));

    if (isAta) {
      const owner = ix.keys[2]?.pubkey;
      if (!owner) throw new Error('Refusing malformed Associated Token Account creation: owner account is missing.');
      if (owner.equals(feePayerPubkey)) {
        throw new Error('Refusing Associated Token Account creation owned by the sponsor fee payer.');
      }
    }
    if (!isAta && !isSystemCreate) return ix;
    const keys = ix.keys.map((k, i) => (i === 0 ? {...k, pubkey: feePayerPubkey} : k));
    return new TransactionInstructionCtor({keys, programId: ix.programId, data: ix.data});
  });
}


const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

/**
 * Redirect cleanup of a newly created temporary WSOL account to the sponsor
 * only when the swap's output is not SOL/WSOL. The account list must already
 * have been checked against chain state so existing user accounts are never
 * included. Never redirect the close authority or the swap's output proceeds.
 */
export function rewriteTemporaryWsolCloseInstructions(
  instructions: TransactionInstruction[],
  temporaryWsolAtaAddresses: ReadonlySet<string>,
  userPubkey: PublicKey,
  sponsorPubkey: PublicKey,
  outputIsNativeSol: boolean,
  TransactionInstructionCtor: typeof import('@solana/web3.js').TransactionInstruction,
): {
  instructions: TransactionInstruction[];
  routeClosedAtas: Set<string>;
  closedBackAtas: Set<string>;
  redirectedClose: boolean;
} {
  const routeClosedAtas = new Set<string>();
  const closedBackAtas = new Set<string>();
  let redirectedClose = false;
  const rewritten = instructions.map(ix => {
    if (!TOKEN_PROGRAM_IDS.has(ix.programId.toBase58())
      || ix.data.length !== 1 || ix.data[0] !== 9 || ix.keys.length < 3) return ix;
    const ata = ix.keys[0].pubkey.toBase58();
    if (!temporaryWsolAtaAddresses.has(ata)) return ix;
    routeClosedAtas.add(ata);

    if (outputIsNativeSol
      || !ix.keys[1].pubkey.equals(userPubkey)
      || !ix.keys[2].pubkey.equals(userPubkey)) return ix;

    const keys = ix.keys.map((key, index) => index === 1
      ? {...key, pubkey: sponsorPubkey}
      : key);
    closedBackAtas.add(ata);
    redirectedClose = true;
    return new TransactionInstructionCtor({programId: ix.programId, keys, data: ix.data});
  });
  return {instructions: rewritten, routeClosedAtas, closedBackAtas, redirectedClose};
}
