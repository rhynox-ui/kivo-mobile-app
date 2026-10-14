import assert from 'node:assert/strict';
import { solanaOutputVerificationFor } from '../trading/core/executeRelayQuote.ts';

const owner = '11111111111111111111111111111111';
const solanaIntent = {destinationChainId: 792703809};
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

await assert.rejects(() => solanaOutputVerificationFor({details: {}}, solanaIntent, owner), /omitted its expected output token or minimum receive amount/);
await assert.rejects(() => solanaOutputVerificationFor({details: {currencyOut: {currency: {address: mint}}}}, solanaIntent, owner), /omitted its expected output token or minimum receive amount/);
await assert.rejects(() => solanaOutputVerificationFor({details: {currencyOut: {currency: {address: mint}, minimumAmount: '0'}}}, solanaIntent, owner), /omitted its expected output token or minimum receive amount/);
await assert.rejects(() => solanaOutputVerificationFor({details: {currencyOut: {currency: {address: '11111111111111111111111111111111'}, minimumAmount: '1'}}}, solanaIntent, owner), /Native SOL output cannot be verified safely/);
await assert.rejects(() => solanaOutputVerificationFor({details: {currencyOut: {currency: {address: 'So11111111111111111111111111111111111111112'}, minimumAmount: '1'}}}, solanaIntent, owner), /Native SOL output cannot be verified safely/);
await assert.rejects(() => solanaOutputVerificationFor({details: {currencyOut: {currency: {address: 'not-a-mint'}, minimumAmount: '1'}}}, solanaIntent, owner), /could not be verified safely/);
assert.deepEqual(await solanaOutputVerificationFor({details: {}}, {destinationChainId: 8453}, owner), {});

console.log('Solana output verification checks passed: missing/zero minimum and unverified native outputs fail closed.');
