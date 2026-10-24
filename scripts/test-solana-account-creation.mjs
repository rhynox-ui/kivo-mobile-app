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
test('leaves the user as payer of an existing ATA (skip-set): its create is a no-op',()=>{const [ix]=rewriteAccountCreationFundingInstructions([ataCreate(user,Buffer.from([1]))],sponsor,TransactionInstruction,{skipAccounts:new Set([ata.toBase58()])});assert(ix.keys[0].pubkey.equals(user));});
test('still rejects a sponsor-owned ATA even when skipped',()=>{assert.throws(()=>rewriteAccountCreationFundingInstructions([ataCreate(sponsor)],sponsor,TransactionInstruction,{skipAccounts:new Set([ata.toBase58()])}),/owned by the sponsor fee payer/);});
