// Kivo's Solana sponsor requires every account it funds (and any top-up) to
// be repaid in the same transaction, unless the account is closed back to
// it (web/server/solanaSponsor.ts). These checks cover the pure rent math and
// drive signAndSendSponsoredSolanaStep end to end against a mocked RPC and
// sponsor endpoint (nothing is ever sent).
import assert from 'node:assert/strict';
import {Buffer} from 'buffer';
import * as web3 from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {priorityFeeLamports, estimateSponsorshipLamportsCost, sponsorshipRecoveryUsdcUnits, signAndSendSponsoredSolanaStep} from '../trading/core/executeRelayQuote.ts';
import {rentExemptLamports, sponsorFundedRent, systemCreateLamports} from '../trading/core/solanaAccountCreation.ts';
import {assertSolanaTransactionMatchesIntent} from '../trading/core/solanaTxIntent.ts';

const {ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction} = web3;
const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
const swap = SystemProgram.transfer({fromPubkey: a, toPubkey: b, lamports: 1});
const RENT_165 = 2_039_280;
const RENT_170 = 2_074_080;

// --- Pure math -------------------------------------------------------------
assert.equal(rentExemptLamports(165), RENT_165);
assert.equal(rentExemptLamports(170), RENT_170);
assert.equal(priorityFeeLamports([ComputeBudgetProgram.setComputeUnitLimit({units: 400000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1_000_000}), swap]), 400000);
assert.equal(priorityFeeLamports([swap]), 0);
// The real sponsorship cost still counts the network and priority fee (balance checks use it).
assert.equal(estimateSponsorshipLamportsCost([ComputeBudgetProgram.setComputeUnitPrice({microLamports: 5_000_000}), swap], 2), 2 * 5000 + Math.ceil(5_000_000 * 200000 / 1e6));
// CreateAccountWithSeed carries its lamports after the seed (offset 44 + seed length), not at offset 4.
const seeded = SystemProgram.createAccountWithSeed({fromPubkey: a, newAccountPubkey: b, basePubkey: a, seed: 'kivo-seed', lamports: RENT_165, space: 165, programId: a});
assert.equal(systemCreateLamports(seeded), RENT_165);
assert.equal(estimateSponsorshipLamportsCost([seeded], 0), RENT_165);
// ATA rent by token program, and every create assumed new unless known to exist.
const mintA = Keypair.generate().publicKey, mintB = Keypair.generate().publicKey;
const classicAta = createAssociatedTokenAccountIdempotentInstruction(a, getAssociatedTokenAddressSync(mintA, a), a, mintA);
const t22Ata = createAssociatedTokenAccountIdempotentInstruction(a, getAssociatedTokenAddressSync(mintB, a, false, TOKEN_2022_PROGRAM_ID), a, mintB, TOKEN_2022_PROGRAM_ID);
assert.equal(estimateSponsorshipLamportsCost([classicAta, t22Ata], 0), RENT_165 + RENT_170);
assert.equal(estimateSponsorshipLamportsCost([classicAta, t22Ata], 0, new Set([classicAta.keys[1].pubkey.toBase58()])), RENT_170);
console.log('rent math: seeded creates, Token-2022 >= 170 bytes, worst case when existence is unknown');

// What the server will require: sponsor-funded creations only, minus closed-back accounts, measured Token-2022.
const sponsorKey = Keypair.generate().publicKey;
const funded = (ix) => new TransactionInstruction({programId: ix.programId, data: ix.data, keys: ix.keys.map((k, i) => (i === 0 ? {...k, pubkey: sponsorKey} : k))});
assert.deepEqual(sponsorFundedRent([classicAta, t22Ata], sponsorKey), {lamports: 0, creations: 0, accounts: []});
assert.equal(sponsorFundedRent([funded(classicAta), funded(t22Ata)], sponsorKey).lamports, RENT_165 + RENT_170);
assert.equal(sponsorFundedRent([funded(classicAta), funded(t22Ata)], sponsorKey, {closedBack: new Set([classicAta.keys[1].pubkey.toBase58()])}).lamports, RENT_170);
assert.equal(sponsorFundedRent([funded(t22Ata)], sponsorKey, {measured: new Map([[t22Ata.keys[1].pubkey.toBase58(), rentExemptLamports(182)]])}).lamports, rentExemptLamports(182));
assert.equal(sponsorFundedRent([funded(classicAta), funded(t22Ata)], sponsorKey).creations, 2);
console.log('sponsor-funded rent mirrors the server rule');

// 0.002 SOL of rent at $200 = $0.40 -> repaid at cost plus the 3% price/conversion buffer, rounded up.
assert.equal(sponsorshipRecoveryUsdcUnits(2_000_000, 200), Math.ceil(0.4 * 1.03 * 1e6));
assert.equal(sponsorshipRecoveryUsdcUnits(0, 200), 0);
console.log('repayment has no Kivo margin');

// --- End to end against a mocked chain -----------------------------------
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const SPONSOR = new PublicKey('2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki');
const user = Keypair.generate();
const sponsorUsdc = getAssociatedTokenAddressSync(USDC, SPONSOR);
const userUsdc = getAssociatedTokenAddressSync(USDC, user.publicKey);
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user.publicKey);
const SOL_PRICE = 200;

const decode = tx => tx.message.compiledInstructions.map(ix => ({
  program: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),
  accounts: ix.accountKeyIndexes.map(i => tx.message.staticAccountKeys[i].toBase58()),
  data: Buffer.from(ix.data),
}));
const tokenAccountData = (mint, owner, amount) => {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return [data.toString('base64'), 'base64'];
};

let scenario;
let sentToSponsor = null;
const proto = Connection.prototype;
proto.getBalance = async pubkey => (pubkey.equals(SPONSOR) ? 5_000_000_000 : scenario.userLamports ?? 0);
proto.getLatestBlockhash = async () => ({blockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), lastValidBlockHeight: 1});
proto.getMultipleAccountsInfo = async keys => keys.map(k => (scenario.existing.has(k.toBase58()) ? {lamports: RENT_165, owner: TOKEN_PROGRAM, data: Buffer.alloc(165), executable: false} : null));
proto.getAccountInfo = async key => (key.equals(sponsorUsdc) && scenario.sponsorUsdcExists !== false ? {lamports: RENT_165, owner: TOKEN_PROGRAM, data: Buffer.alloc(165), executable: false} : null);
proto.getParsedTokenAccountsByOwner = async () => ({value: []});
proto.simulateTransaction = async (tx, config) => {
  const ixs = decode(tx);
  const err = scenario.fails?.(ixs) ? {InstructionError: [ixs.length - 1, {Custom: 1}]} : null;
  const addresses = config?.accounts?.addresses ?? [];
  const accounts = addresses.map(address => {
    if (address === user.publicKey.toBase58()) return {lamports: scenario.userLamports ?? 0, data: ['', 'base64'], owner: SystemProgram.programId.toBase58(), executable: false};
    if (address === wsolAta.toBase58()) {
      const closed = ixs.some(ix => ix.program === TOKEN_PROGRAM.toBase58() && ix.data[0] === 9 && ix.accounts[0] === address);
      return closed ? null : {lamports: RENT_165 + (scenario.wsolLeft ?? 0), data: tokenAccountData(NATIVE_MINT, user.publicKey, BigInt(scenario.wsolLeft ?? 0)), owner: TOKEN_PROGRAM.toBase58(), executable: false};
    }
    return null;
  });
  return {context: {slot: 1}, value: {err, logs: [], accounts, unitsConsumed: 120_000}};
};
proto.sendRawTransaction = async () => 'sig';
proto.getSignatureStatuses = async () => ({value: [{err: null, confirmationStatus: 'confirmed'}]});
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes('/api/solana/fee-payer')) return new Response(JSON.stringify({data: {publicKey: SPONSOR.toBase58()}}));
  if (href.includes('/api/solana/sponsor-fee')) {
    sentToSponsor = VersionedTransaction.deserialize(Buffer.from(JSON.parse(init.body).transaction, 'base64'));
    return new Response(JSON.stringify({data: {transaction: JSON.parse(init.body).transaction}}));
  }
  if (href.includes('price/v3')) return new Response(JSON.stringify({[NATIVE_MINT.toBase58()]: {usdPrice: SOL_PRICE}}));
  if (href.includes('simple/price')) return new Response(JSON.stringify({solana: {usd: SOL_PRICE - 1}}));
  return new Response('{}', {status: 404});
};

const signer = {publicKey: user.publicKey, sign: async tx => { tx.sign([user]); return tx; }};
const connection = new Connection('http://mocked.invalid', 'confirmed');
const userCreate = (owner, mint, programId = TOKEN_PROGRAM) => createAssociatedTokenAccountIdempotentInstruction(user.publicKey, getAssociatedTokenAddressSync(mint, owner, true, programId), owner, mint, programId);
const swapIx = () => new TransactionInstruction({programId: JUPITER, keys: [{pubkey: user.publicKey, isSigner: true, isWritable: true}, {pubkey: wsolAta, isSigner: false, isWritable: true}], data: Buffer.from([1])});
const usdcUnitsFor = lamports => BigInt(Math.ceil(lamports / 1e9 * SOL_PRICE * 1.03 * 1e6));
const repaymentsIn = ixs => ({
  usdc: ixs.filter(ix => ix.program === TOKEN_PROGRAM.toBase58() && ix.data[0] === 3 && ix.accounts[1] === sponsorUsdc.toBase58()).reduce((s, ix) => s + ix.data.readBigUInt64LE(1), 0n),
  sol: ixs.filter(ix => ix.program === SystemProgram.programId.toBase58() && ix.data.readUInt32LE(0) === 2 && ix.accounts[1] === SPONSOR.toBase58()).reduce((s, ix) => s + ix.data.readBigUInt64LE(4), 0n),
});

// 1. URGENT: USDC -> SOL -> token buy through Jupiter. The WSOL account is new
// (sponsor-funded) and only used in passing; the output account is new; the
// USDC account already exists.
{
  const output = Keypair.generate().publicKey;
  const outputAta = getAssociatedTokenAddressSync(output, user.publicKey);
  scenario = {existing: new Set([userUsdc.toBase58()])};
  sentToSponsor = null;
  await signAndSendSponsoredSolanaStep([
    ComputeBudgetProgram.setComputeUnitLimit({units: 300_000}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1000}),
    userCreate(user.publicKey, NATIVE_MINT),
    userCreate(user.publicKey, output),
    userCreate(user.publicKey, USDC),
    swapIx(),
    createCloseAccountInstruction(wsolAta, user.publicKey, user.publicKey),
  ], [], signer, connection, {spend: USDC.toBase58(), maxSpend: 10_000_000n});
  const ixs = decode(sentToSponsor);
  const creates = ixs.filter(ix => ix.program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(creates.find(ix => ix.accounts[1] === wsolAta.toBase58()).accounts[0], SPONSOR.toBase58(), 'new WSOL account is sponsor-funded');
  assert.equal(creates.find(ix => ix.accounts[1] === outputAta.toBase58()).accounts[0], SPONSOR.toBase58(), 'new output account is sponsor-funded');
  assert.equal(creates.find(ix => ix.accounts[1] === userUsdc.toBase58()).accounts[0], user.publicKey.toBase58(), 'existing account keeps the user as no-op payer');
  const closes = ixs.filter(ix => ix.program === TOKEN_PROGRAM.toBase58() && ix.data[0] === 9);
  assert.equal(closes.length, 1, 'no second close of the WSOL account');
  assert.equal(closes[0].accounts[1], SPONSOR.toBase58(), "route's WSOL close is redirected to the sponsor");
  assert.deepEqual(repaymentsIn(ixs), {usdc: usdcUnitsFor(RENT_165), sol: 0n}, 'only the output account rent is repaid, in USDC');
  if (process.env.KIVO_DUMP_SPONSOR_TX) (await import('node:fs')).writeFileSync(process.env.KIVO_DUMP_SPONSOR_TX, Buffer.from(sentToSponsor.serialize()).toString('base64'));
  console.log('USDC -> SOL -> token buy: WSOL rent closed back to the sponsor, output account repaid in USDC');
}

// 2. Sell to SOL: the WSOL account holds the proceeds, so its close stays the
// user's (it unwraps their SOL) and the rent is repaid in SOL from them.
{
  scenario = {existing: new Set(), wsolLeft: 50_000_000, sponsorUsdcExists: false};
  sentToSponsor = null;
  await signAndSendSponsoredSolanaStep([
    userCreate(user.publicKey, NATIVE_MINT), swapIx(), createCloseAccountInstruction(wsolAta, user.publicKey, user.publicKey),
  ], [], signer, connection, {spend: Keypair.generate().publicKey.toBase58(), maxSpend: 1n});
  const ixs = decode(sentToSponsor);
  const close = ixs.find(ix => ix.program === TOKEN_PROGRAM.toBase58() && ix.data[0] === 9);
  assert.equal(close.accounts[1], user.publicKey.toBase58(), 'proceeds are never redirected to the sponsor');
  assert.deepEqual(repaymentsIn(ixs), {usdc: 0n, sol: BigInt(RENT_165)}, 'WSOL rent repaid in SOL');
  console.log('sell to SOL: proceeds stay the user\'s, WSOL rent repaid in SOL');
}

// 3. Send creating the recipient's token account, repaid in USDC.
{
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const target = getAssociatedTokenAddressSync(mint, recipient);
  scenario = {existing: new Set()};
  sentToSponsor = null;
  await signAndSendSponsoredSolanaStep([
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, target, recipient, mint),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, user.publicKey), mint, target, user.publicKey, 5_000n, 6),
  ], [], signer, connection, {spend: mint.toBase58(), maxSpend: 5_000n}, {allowedAtaOwners: [recipient.toBase58()]});
  const ixs = decode(sentToSponsor);
  assert.equal(ixs.find(ix => ix.accounts[1] === target.toBase58() && ix.program.startsWith('AToken')).accounts[0], SPONSOR.toBase58());
  assert.deepEqual(repaymentsIn(ixs), {usdc: usdcUnitsFor(RENT_165), sol: 0n}, "recipient account rent repaid in USDC");
  console.log('Send to a new recipient: their account rent repaid in USDC');
}

// 4. A withdrawal to an existing account: nothing to repay.
{
  scenario = {existing: new Set()};
  sentToSponsor = null;
  await signAndSendSponsoredSolanaStep([
    createTransferCheckedInstruction(userUsdc, USDC, getAssociatedTokenAddressSync(USDC, Keypair.generate().publicKey), user.publicKey, 1_000_000n, 6),
  ], [], signer, connection, {spend: USDC.toBase58(), maxSpend: 1_000_000n});
  assert.deepEqual(repaymentsIn(decode(sentToSponsor)), {usdc: 0n, sol: 0n});
  console.log('withdrawal to an existing account: no repayment');
}

// 5. Nothing to repay with: refused before signing, with a clear message.
{
  scenario = {existing: new Set(), fails: ixs => ixs.some(ix => (ix.program === TOKEN_PROGRAM.toBase58() && ix.data[0] === 3) || (ix.program === SystemProgram.programId.toBase58() && ix.accounts[1] === SPONSOR.toBase58()))};
  sentToSponsor = null;
  await assert.rejects(signAndSendSponsoredSolanaStep([userCreate(user.publicKey, Keypair.generate().publicKey), swapIx()], [], signer, connection, {spend: USDC.toBase58(), maxSpend: 1n}), /one-time 0\.002039 SOL deposit .*Nothing was sent/);
  assert.equal(sentToSponsor, null);
  console.log('no USDC or SOL to repay with: clear error, nothing signed');
}

// 6. More than three sponsor-funded accounts: refused before signing.
{
  scenario = {existing: new Set()};
  sentToSponsor = null;
  await assert.rejects(signAndSendSponsoredSolanaStep([0, 1, 2, 3].map(() => userCreate(user.publicKey, Keypair.generate().publicKey)), [], signer, connection, {spend: USDC.toBase58(), maxSpend: 1n}), /at most 3/);
  console.log('more than three new accounts: refused before signing');
}

// --- The intent firewall only lets new sponsor-funded WSOL close to the sponsor.
{
  const sponsorCreate = createAssociatedTokenAccountIdempotentInstruction(SPONSOR, wsolAta, user.publicKey, NATIVE_MINT);
  const build = ixs => new VersionedTransaction(new TransactionMessage({payerKey: SPONSOR, recentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), instructions: ixs}).compileToV0Message());
  const closeToSponsor = createCloseAccountInstruction(wsolAta, SPONSOR, user.publicKey);
  const opts = {expectedSigner: user.publicKey.toBase58(), expectedFeePayer: SPONSOR.toBase58()};
  assert.doesNotThrow(() => assertSolanaTransactionMatchesIntent(build([sponsorCreate, swapIx(), closeToSponsor]), {...opts, sponsorClosableAccounts: [wsolAta.toBase58()]}));
  assert.throws(() => assertSolanaTransactionMatchesIntent(build([sponsorCreate, swapIx(), closeToSponsor]), opts), /without returning its recovered funds/);
  // Not created by the sponsor in this transaction (the user's own WSOL): must close to the user.
  assert.throws(() => assertSolanaTransactionMatchesIntent(build([userCreate(user.publicKey, NATIVE_MINT), swapIx(), closeToSponsor]), {...opts, sponsorClosableAccounts: [wsolAta.toBase58()]}), /without returning its recovered funds/);
  const other = getAssociatedTokenAddressSync(USDC, user.publicKey);
  assert.throws(() => assertSolanaTransactionMatchesIntent(build([createAssociatedTokenAccountIdempotentInstruction(SPONSOR, other, user.publicKey, USDC), createCloseAccountInstruction(other, SPONSOR, user.publicKey)]), {...opts, sponsorClosableAccounts: [other.toBase58()]}), /without returning its recovered funds/);
  console.log('intent firewall: only new sponsor-funded WSOL accounts may close to the sponsor');
}
