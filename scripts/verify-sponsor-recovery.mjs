import assert from 'node:assert/strict';
import {ComputeBudgetProgram, SystemProgram, Keypair} from '@solana/web3.js';
import {priorityFeeLamports, estimateSponsorshipLamportsCost, estimateRecoverableRentLamports, sponsorshipRecoveryUsdcUnits} from '../trading/core/executeRelayQuote.ts';
const a=Keypair.generate().publicKey,b=Keypair.generate().publicKey;
const swap=SystemProgram.transfer({fromPubkey:a,toPubkey:b,lamports:1});
assert.equal(priorityFeeLamports([ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000}),swap]),400000);
assert.equal(priorityFeeLamports([swap]),0);
// The real sponsorship cost still counts the network and priority fee (balance checks use it).
assert.equal(estimateSponsorshipLamportsCost([ComputeBudgetProgram.setComputeUnitPrice({microLamports:5_000_000}),swap],2,0),2*5000+Math.ceil(5_000_000*200000/1e6));
console.log('priority fee counted in the real cost');
// What Kivo recovers from the user: rent only. Network and priority fees are Kivo's.
assert.equal(estimateRecoverableRentLamports([ComputeBudgetProgram.setComputeUnitPrice({microLamports:5_000_000}),swap],2_039_280),0);
const rentIx=SystemProgram.createAccount({fromPubkey:a,newAccountPubkey:b,lamports:2_039_280,space:165,programId:a});
assert.equal(estimateRecoverableRentLamports([ComputeBudgetProgram.setComputeUnitPrice({microLamports:5_000_000}),rentIx],0),2_039_280);
console.log('recovery is rent only, no network or priority fee');
// 0.002 SOL of rent at $200 = $0.40 -> recovered at cost plus the 1% conversion buffer, no margin.
assert.equal(sponsorshipRecoveryUsdcUnits(2_000_000, 200), Math.round(0.4 * 1.01 * 1e6));
console.log('recovery has no Kivo margin');
