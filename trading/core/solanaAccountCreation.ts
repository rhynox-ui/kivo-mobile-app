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
