import assert from 'node:assert/strict';
import { solanaOutputVerificationFor } from '../trading/core/solanaOutputGuard.ts';
import { assertSolanaTransactionMatchesIntent } from '../trading/core/solanaTxIntent.ts';

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

// A top-level ATA create must never make the user pay rent for another wallet.
const ataProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const systemProgram = '11111111111111111111111111111111';
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const user = 'UserWalletBase58CaseSensitive111111111111';
const otherWallet = 'OtherWalletBase58CaseSensitive11111111111';
const ataInstruction = owner => ({
  programId: {toBase58: () => ataProgram},
  data: new Uint8Array(0),
  keys: [
    {pubkey: {toBase58: () => user}, isSigner: true},
    {pubkey: {toBase58: () => 'AtaAddressFixture111111111111111111111111'}},
    {pubkey: {toBase58: () => owner}},
    {pubkey: {toBase58: () => mint}},
    {pubkey: {toBase58: () => systemProgram}},
    {pubkey: {toBase58: () => tokenProgram}},
  ],
});
const legacyAtaTx = owner => ({feePayer: {toBase58: () => user}, instructions: [ataInstruction(owner)]});
assert.doesNotThrow(() => assertSolanaTransactionMatchesIntent(legacyAtaTx(user), {expectedSigner: user}));
assert.throws(
  () => assertSolanaTransactionMatchesIntent(legacyAtaTx(otherWallet), {expectedSigner: user}),
  /pay rent to create a token account for another wallet/,
);

console.log('Solana output verification checks passed: missing/zero minimum and unverified native outputs fail closed.');
