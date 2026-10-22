import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Keypair, PublicKey, SystemProgram, TransactionInstruction} from '@solana/web3.js';
import {rewriteAccountCreationFundingInstructions, rewriteTemporaryWsolCloseInstructions} from '../trading/core/solanaAccountCreation.ts';
const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const sponsor = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
function ataCreate(owner, data = Buffer.alloc(0)) {
 return new TransactionInstruction({programId:ataProgram,keys:[
 {pubkey:user,isSigner:true,isWritable:true},{pubkey:ata,isSigner:false,isWritable:true},
 {pubkey:owner,isSigner:false,isWritable:false},{pubkey:mint,isSigner:false,isWritable:false},
 {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:tokenProgram,isSigner:false,isWritable:false}],data});
}
test('rewrites ordinary ATA Create payer',()=>{const [ix]=rewriteAccountCreationFundingInstructions([ataCreate(user)],sponsor,TransactionInstruction);assert(ix.keys[0].pubkey.equals(sponsor));assert(ix.keys[2].pubkey.equals(user));});
test('rewrites ordinary ATA CreateIdempotent payer',()=>{const [ix]=rewriteAccountCreationFundingInstructions([ataCreate(user,Buffer.from([1]))],sponsor,TransactionInstruction);assert(ix.keys[0].pubkey.equals(sponsor));assert(ix.keys[2].pubkey.equals(user));});
test('rejects sponsor-owned ATA Create',()=>{assert.throws(()=>rewriteAccountCreationFundingInstructions([ataCreate(sponsor)],sponsor,TransactionInstruction),/owned by the sponsor fee payer/);});
test('rejects sponsor-owned ATA CreateIdempotent',()=>{assert.throws(()=>rewriteAccountCreationFundingInstructions([ataCreate(sponsor,Buffer.from([1]))],sponsor,TransactionInstruction),/owned by the sponsor fee payer/);});
test('rewrites System CreateAccount payer',()=>{const dest=Keypair.generate().publicKey;const ix=SystemProgram.createAccount({fromPubkey:user,newAccountPubkey:dest,lamports:1,space:0,programId:SystemProgram.programId});const [out]=rewriteAccountCreationFundingInstructions([ix],sponsor,TransactionInstruction);assert(out.keys[0].pubkey.equals(sponsor));assert(out.keys[1].pubkey.equals(dest));});
test('leaves unrelated instructions untouched',()=>{const ix=new TransactionInstruction({programId:tokenProgram,keys:[],data:Buffer.from([9])});assert.equal(rewriteAccountCreationFundingInstructions([ix],sponsor,TransactionInstruction)[0],ix);});


function closeWsol(account, destination, authority) {
 return new TransactionInstruction({programId:tokenProgram,keys:[
  {pubkey:account,isSigner:false,isWritable:true},
  {pubkey:destination,isSigner:false,isWritable:true},
  {pubkey:authority,isSigner:true,isWritable:false},
 ],data:Buffer.from([9])});
}
test('redirects temporary WSOL cleanup rent to sponsor for token-output swaps',()=>{
 const [out]=[rewriteTemporaryWsolCloseInstructions([closeWsol(ata,user,user)],new Set([ata.toBase58()]),user,sponsor,false,TransactionInstruction)];
 assert(out.redirectedClose);
 assert(out.instructions[0].keys[1].pubkey.equals(sponsor));
 assert(out.instructions[0].keys[2].pubkey.equals(user));
 assert(out.closedBackAtas.has(ata.toBase58()));
 assert(out.routeClosedAtas.has(ata.toBase58()));
});
test('preserves user destination for native SOL/WSOL output',()=>{
 const out=rewriteTemporaryWsolCloseInstructions([closeWsol(ata,user,user)],new Set([ata.toBase58()]),user,sponsor,true,TransactionInstruction);
 assert.equal(out.redirectedClose,false);
 assert(out.instructions[0].keys[1].pubkey.equals(user));
 assert.equal(out.closedBackAtas.size,0);
 assert(out.routeClosedAtas.has(ata.toBase58()));
});
test('does not rewrite a close for an account not created by this transaction',()=>{
 const otherAta=Keypair.generate().publicKey;
 const out=rewriteTemporaryWsolCloseInstructions([closeWsol(otherAta,user,user)],new Set([ata.toBase58()]),user,sponsor,false,TransactionInstruction);
 assert.equal(out.redirectedClose,false);
 assert(out.instructions[0].keys[1].pubkey.equals(user));
 assert.equal(out.routeClosedAtas.size,0);
});
test('does not redirect a WSOL close with a different authority or destination',()=>{
 const other=Keypair.generate().publicKey;
 const out=rewriteTemporaryWsolCloseInstructions([closeWsol(ata,other,user)],new Set([ata.toBase58()]),user,sponsor,false,TransactionInstruction);
 assert.equal(out.redirectedClose,false);
 assert(out.instructions[0].keys[1].pubkey.equals(other));
 assert.equal(out.closedBackAtas.size,0);
});
