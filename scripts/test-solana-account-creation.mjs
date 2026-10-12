import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Keypair, PublicKey, SystemProgram, TransactionInstruction} from '@solana/web3.js';
import {rewriteAccountCreationFundingInstructions} from '../trading/core/solanaAccountCreation.ts';

const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const sponsor = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const systemProgram = SystemProgram.programId;

function ataCreate(owner, data = Buffer.alloc(0)) {
  return new TransactionInstruction({
    programId: ataProgram,
    keys: [
      {pubkey: user, isSigner: true, isWritable: true},
      {pubkey: ata, isSigner: false, isWritable: true},
      {pubkey: owner, isSigner: false, isWritable: false},
      {pubkey: mint, isSigner: false, isWritable: false},
      {pubkey: systemProgram, isSigner: false, isWritable: false},
      {pubkey: tokenProgram, isSigner: false, isWritable: false},
    ],
    data,
  });
}

test('rewrites ordinary ATA Create payer to sponsor', () => {
  const [result] = rewriteAccountCreationFundingInstructions([ataCreate(user)], sponsor, TransactionInstruction);
  assert.equal(result.keys[0].pubkey.toBase58(), sponsor.toBase58());
  assert.equal(result.keys[2].pubkey.toBase58(), user.toBase58());
});

test('rewrites ordinary ATA CreateIdempotent payer to sponsor', () => {
  const [result] = rewriteAccountCreationFundingInstructions([ataCreate(user, Buffer.from([1]))], sponsor, TransactionInstruction);
  assert.equal(result.keys[0].pubkey.toBase58(), sponsor.toBase58());
  assert.equal(result.keys[2].pubkey.toBase58(), user.toBase58());
});

test('rejects ATA Create owned by sponsor before payer rewrite', () => {
  assert.throws(
    () => rewriteAccountCreationFundingInstructions([ataCreate(sponsor)], sponsor, TransactionInstruction),
    /owned by the sponsor fee payer/,
  );
});

test('rejects ATA CreateIdempotent owned by sponsor before payer rewrite', () => {
  assert.throws(
    () => rewriteAccountCreationFundingInstructions([ataCreate(sponsor, Buffer.from([1]))], sponsor, TransactionInstruction),
    /owned by the sponsor fee payer/,
  );
});

test('rewrites System CreateAccount payer without changing destination', () => {
  const destination = Keypair.generate().publicKey;
  const ix = SystemProgram.createAccount({fromPubkey: user, newAccountPubkey: destination, lamports: 1, space: 0, programId: systemProgram});
  const [result] = rewriteAccountCreationFundingInstructions([ix], sponsor, TransactionInstruction);
  assert.equal(result.keys[0].pubkey.toBase58(), sponsor.toBase58());
  assert.equal(result.keys[1].pubkey.toBase58(), destination.toBase58());
});

test('leaves unrelated instructions unchanged', () => {
  const ix = new TransactionInstruction({programId: tokenProgram, keys: [], data: Buffer.from([9])});
  const [result] = rewriteAccountCreationFundingInstructions([ix], sponsor, TransactionInstruction);
  assert.equal(result, ix);
});
