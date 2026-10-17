import assert from 'node:assert/strict';
import {ComputeBudgetProgram, SystemProgram, Keypair} from '@solana/web3.js';
import {priorityFeeLamports, estimateSponsorshipLamportsCost} from '../trading/core/executeRelayQuote.ts';
const a=Keypair.generate().publicKey,b=Keypair.generate().publicKey;
const swap=SystemProgram.transfer({fromPubkey:a,toPubkey:b,lamports:1});
assert.equal(priorityFeeLamports([ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000}),swap]),400000);
assert.equal(priorityFeeLamports([swap]),0);
assert.equal(estimateSponsorshipLamportsCost([ComputeBudgetProgram.setComputeUnitPrice({microLamports:5_000_000}),swap],2,0),2*5000+Math.ceil(5_000_000*200000/1e6));
console.log('priority fee counted');
import {sponsorshipRecoveryUsdcUnits, SPONSORSHIP_RECOVERY_MARGIN_PCT} from '../trading/core/executeRelayQuote.ts';
// 0.002 SOL at $200 = $0.40 cost -> recovered with buffer + margin.
assert.equal(sponsorshipRecoveryUsdcUnits(2_000_000, 200), Math.round(0.4 * (1.01 + SPONSORSHIP_RECOVERY_MARGIN_PCT) * 1e6));
console.log('recovery includes Kivo margin');
