// src/core/executeRelayQuote.ts
//
// Turns a getRelayQuote() result into signed, broadcast transactions —
// the piece relayQuote.ts's own earlier header named as the blocker on
// real trading, and the reason src/core/txIntentFirewall.ts and
// solanaTxIntent.ts were ported first. Direct-broadcast, same confirmed
// architecture as the rest of this app's wallet code (sendUsdc.ts):
// this device signs with the session's own key and submits straight to
// each chain, no backend in between.
//
// Two references combined, neither ported alone:
// - mango-bridge.jsx's own src/relaybridge.js for HOW the firewall gets
//   wired into execution: read the intent tagged onto the quote object
//   (relayQuote.ts's own intentForQuote()), run assertQuoteSafeToSign
//   against every still-pending item BEFORE signing the first one, log
//   (never swallow) any warnings, THEN sign step by step.
// - mango-mobile's own src/bridge/relayBridge.js for the actual signing
//   mechanics, since the site signs through wagmi/an external wallet
//   and this app IS the wallet: sendRelayEvmStep's pre-flight simulate
//   + native-balance check (a clear "insufficient ETH for gas" instead
//   of a wallet just failing), and signAndSendRelaySolanaStep's hardened
//   retry (insufficient-lamports detection, and a skipPreflight retry +
//   landed-check for the well-documented case where a public RPC's own
//   stale simulation snapshot rejects a transaction that the real
//   cluster accepts a moment later).
//
// Solana routes may still contain WSOL internally when Relay/Jupiter
// needs it; the intent firewall now validates legitimate cleanup rather
// than assuming every CloseAccount is malicious.
// so there's nothing left to unwrap (see mobile's own long comment on
// why that fix made the whole cleanup path unnecessary going forward).

import {privateKeyToAccount} from 'viem/accounts';
import {Buffer} from 'buffer';
import {viemChainForChainId} from './chainRegistry.ts';
import {assertQuoteSafeToSign, type TransactionIntent} from './txIntentFirewall.ts';
import {assertSolanaTransactionMatchesIntent} from './solanaTxIntent.ts';
import {SOLANA_NATIVE_SPEND, assertSolanaSpendWithinIntentWeb3, isInsufficientSolSimulation, type SolanaSpendIntent} from './solanaSpendGuard.ts';
import {intentForQuote, type RelayQuote, type RelayTransactionStepItem} from './relayQuote.ts';
import {TOKEN_ADDRESSES, ASSET_ONCHAIN_DECIMALS, ARC_USDC, MAINNET_CHAIN_IDS} from './chainData.ts';
import {preflightRelayGaslessEvm, sendEvmCallsViaRelayGasless} from './relayGaslessEvm.ts';
import {fetchWalletPrices} from './walletPrices.ts';
import type {DerivedAccounts} from '../wallet/keys';

const RELAY_STATUS_URL = 'https://api.relay.link/intents/status/v3';
const SOLANA_RPC_URL = 'https://rpc.solanatracker.io/public';
// Read-only token-account RPC only. Execution, simulation, signing, sending,
// blockhashes, and confirmations continue to use SOLANA_RPC_URL unchanged.
const SOLANA_TOKEN_ACCOUNT_READ_RPC_URL = 'https://api.mainnet.solana.com';
// Sponsored-transaction simulation uses a standard Solana Labs mainnet RPC.
// SOLANA_RPC_URL remains the execution/read/send path; this only prevents a
// non-standard public RPC from reporting a false AccountNotFound for the
// sponsor fee payer during pre-sign simulation.
const SOLANA_SIMULATION_RPC_URL = 'https://api.mainnet.solana.com';

// Real fix for a structural Solana gap, confirmed via real research
// (Solana's own cookbook, and how Alchemy/Privy's production wallet
// infra actually implement this) — see Kivo backend's own
// solana-fee-payer.js for the full reasoning and every safety check
// enforced server-side before it ever adds its signature. This app's
// own job, client-side: fetch that wallet's public key, REWRITE any
// instruction that creates AND funds a new account (verified directly
// against Solana's system_instruction.rs and the SPL Associated Token
// Account spec — never assumed) so IT funds that account instead of
// this wallet, THEN sign — in that order, so the fee payer only ever
// adds a signature to a message this wallet's own key already fixed,
// never the other way around (Relay's own docs flag the reverse order
// as exploitable for a same-chain Solana swap; Privy's own documented
// pattern is this same safer order).
const SOLANA_FEE_PAYER_URL: string | null = 'https://kivotrade.site/api/solana/fee-payer';
const SOLANA_SPONSOR_FEE_URL: string | null = 'https://kivotrade.site/api/solana/sponsor-fee';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
// System Program instruction discriminants (the little-endian u32 at
// the start of instruction data) for the two variants that create AND
// fund a new account in one step — verified against the real
// SystemInstruction enum's declared order, not assumed: CreateAccount
// is the 1st variant (0), CreateAccountWithSeed the 4th (3). Both put
// the funding account at account index 0, same as the Associated Token
// Account Program's Create/CreateIdempotent — confirmed against each
// spec directly rather than assumed to match by analogy.
const SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS = new Set([0, 3]);

let cachedSolanaFeePayerPublicKey: string | null = null;
async function getSolanaFeePayerPublicKey(): Promise<string> {
  if (cachedSolanaFeePayerPublicKey) return cachedSolanaFeePayerPublicKey;
  if (!SOLANA_FEE_PAYER_URL) throw new Error('Kivo Solana fee sponsorship is not configured.');
  const res = await fetch(SOLANA_FEE_PAYER_URL);
  if (!res.ok) throw new Error('Fee sponsorship is not available right now.');
  const {data} = (await res.json()) as {data?: {publicKey?: string}};
  if (!data?.publicKey) throw new Error('Fee sponsorship is not available right now.');
  cachedSolanaFeePayerPublicKey = data.publicKey;
  return cachedSolanaFeePayerPublicKey;
}

// A quote's gas/rate numbers are only fresh for a short window — this is
// this app's own client-side clock (relayQuote.ts's quotedAt tag), not a
// field Relay's response schema documents itself.
const RELAY_QUOTE_MAX_AGE_MS = 2 * 60 * 1000;

export type ExecuteStep = 'build' | 'signing' | 'filling' | 'done';

function isSolanaShaped(item: RelayTransactionStepItem): boolean {
  return Boolean(item.data?.instructions);
}

/** What a Solana step may spend: exactly the trade's own input (see solanaSpendGuard.ts). */
export function solanaSpendIntentFor(intent: TransactionIntent): SolanaSpendIntent {
  // Relay (and chainData.ts) name native SOL by the System Program id, which
  // txIntentFirewall's EVM-style native sentinels don't include.
  if (intent.originIsNative || !intent.originCurrency || intent.originCurrency === SYSTEM_PROGRAM_ID) return {spend: SOLANA_NATIVE_SPEND, maxSpend: intent.amount};
  return {spend: intent.originCurrency, maxSpend: intent.amount};
}

export async function solanaOutputVerificationFor(quote: RelayQuote, intent: TransactionIntent, ownerAddress: string): Promise<Pick<SolanaSpendIntent, 'expectedOutputMint' | 'expectedOutputMinimum' | 'expectedOutputAccounts'>> {
  if (intent.destinationChainId !== 792703809) return {};
  const output = quote.details?.currencyOut;
  const mint = output?.currency?.address;
  const minimumAmount = output?.minimumAmount ?? output?.amount;
  if (!mint || !minimumAmount || !/^\d+$/.test(minimumAmount)) return {};
  if (mint === SYSTEM_PROGRAM_ID || mint === 'So11111111111111111111111111111111111111112') return {};
  try {
    const [{PublicKey}, splToken] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
    const owner = new PublicKey(ownerAddress);
    const mintKey = new PublicKey(mint);
    const accounts = await Promise.all([
      splToken.getAssociatedTokenAddress(mintKey, owner, false, splToken.TOKEN_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
      splToken.getAssociatedTokenAddress(mintKey, owner, false, splToken.TOKEN_2022_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
    ]);
    return {expectedOutputMint: mint, expectedOutputMinimum: BigInt(minimumAmount), expectedOutputAccounts: accounts.map(a => a.toBase58())};
  } catch {
    throw new Error('The Solana output could not be verified safely — refusing to sign this trade.');
  }
}
async function pollRelayStatus(requestId: string, {intervalMs = 2000, timeoutMs = 10 * 60 * 1000}: {intervalMs?: number; timeoutMs?: number} = {}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${RELAY_STATUS_URL}?requestId=${requestId}`);
    if (res.ok) {
      const data = (await res.json()) as {status?: string};
      if (data.status === 'success') return;
      if (data.status === 'failure') throw new Error("Relay reported this trade failed — check the requestId on relay.link for details.");
    }
    await new Promise<void>(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Relay to confirm completion. Your transaction was broadcast — check status manually using the requestId before retrying.');
}

/**
 * On Arc, the USDC ERC-20 a step spends and the gas it pays come out of
 * one balance: eth_getBalance reports it with 18 decimals, the token with
 * 6. The native-balance check must count the USDC being spent too, or a
 * MAX-sized trade passes the check and then reverts on-chain after the
 * gas is already taken. Returns that USDC in native (18-decimal) units,
 * or 0n on every other chain and for any other origin token.
 */
export function arcUsdcSpendInNativeUnits(chainId: number | undefined, originToken: `0x${string}` | undefined, originAmount: bigint | undefined): bigint {
  if (chainId !== MAINNET_CHAIN_IDS.arc || !originToken || !originAmount || originAmount <= 0n) return 0n;
  if (originToken.toLowerCase() !== ARC_USDC) return 0n;
  return originAmount * 10n ** 12n;
}

const ARC_INSUFFICIENT_MESSAGE = "Insufficient USDC for network fees on Arc. Gas there is paid in the same USDC you're spending — try a slightly smaller amount.";

/**
 * Sends one EVM-side Relay step. Simulates first (publicClient.call) so
 * a route that would revert on-chain fails with a real, readable reason
 * instead of burning gas to find out; then checks the native balance
 * actually covers value + worst-case gas cost before broadcasting.
 *
 * `originToken`/`originAmount` (the whole quote's currencyIn — see
 * executeRelayQuote's own top) are only ever consulted if this pre-flight
 * simulate reverts, as the allowance-recovery fallback above.
 */
/**
 * Same shape as sendRelayEvmStep above (simulate first, check the
 * native balance actually covers value + worst-case gas, THEN send) but
 * for a Google-login session: there's no local account to build a
 * walletClient from, so the final sign+broadcast goes through
 * particleSigning.ts's Particle MPC path instead of viem's
 * walletClient.sendTransaction. Kept as a fully separate function
 * rather than threading a branch through sendRelayEvmStep itself —
 * zero risk of this new path changing behavior for the existing,
 * already-relied-on local-signing one.
 */
/**
 * Signs and sends one Solana-side Relay step, with the two hardened
 * fallbacks mango-mobile's own relayBridge.js added after live
 * failures: a clear "insufficient SOL" message when the preflight
 * simulation says so, and a skipPreflight retry (falling back to a
 * direct landed-check) for the well-documented case where a public
 * RPC's own simulation snapshot lags the real cluster by a moment.
 */
/** Polls until a Solana signature confirms, fails on-chain, or times out — shared by the plain and sponsored signing paths below. */
async function confirmSolanaSignature(connection: InstanceType<typeof import('@solana/web3.js').Connection>, signature: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const {value} = await connection.getSignatureStatuses([signature]);
    const status = value?.[0];
    if (status) {
      if (status.err) {
        const error = new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
        (error as {signature?: string}).signature = signature;
        throw error;
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return signature;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for transaction ${signature} to confirm.`);
    await new Promise<void>(r => setTimeout(r, 1200));
  }
}

/**
 * Retries a Solana step that failed for lack of native SOL by having
 * Kivo's own funded wallet pay the network fee AND fund any new
 * account this route creates along the way (e.g. a temporary
 * wrapped-SOL account for a token that only pairs against SOL, never
 * USDC directly) — see this file's own header above for the full
 * reasoning and Kivo backend's solana-fee-payer.js for every safety check
 * enforced before that wallet ever adds its signature.
 *
 * Rewrites the funding account of any instruction that creates AND
 * funds a new account to Kivo's fee-payer wallet BEFORE anyone signs,
 * then signs with this wallet's own key — locking the exact, final
 * message — and only THEN sends it to be co-signed. That order is the
 * whole safety property: the fee payer only ever adds a signature to a
 * message this wallet's own key already fixed, never the reverse.
 */
/**
 * Pure rewrite step, kept separate from any signing/network I/O so it's
 * independently testable (scripts/verify-solana-fee-sponsor.mjs) — the
 * one piece of this whole feature where getting the account index wrong
 * either breaks the transaction or silently fails to fix anything.
 * Detects any instruction that creates AND funds a new account
 * (verified directly against Solana's system_instruction.rs and the
 * SPL Associated Token Account spec, not assumed) and redirects its
 * funding account (always account index 0 for all three shapes this
 * checks) to `feePayerPubkey`. Every other instruction — including the
 * actual swap/transfer instructions carrying the user's own real
 * trade — passes through completely untouched.
 */
export function rewriteAccountCreationFundingInstructions(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  feePayerPubkey: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  TransactionInstructionCtor: typeof import('@solana/web3.js').TransactionInstruction,
): InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[] {
  return instructions.map(ix => {
    const programId = ix.programId.toBase58();
    const isAssociatedTokenAccountCreate = programId === ASSOCIATED_TOKEN_PROGRAM_ID;
    const isSystemAccountCreate = programId === SYSTEM_PROGRAM_ID && ix.data.length >= 4 && SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS.has(ix.data.readUInt32LE(0));
    if (!isAssociatedTokenAccountCreate && !isSystemAccountCreate) return ix;
    const keys = ix.keys.map((k, i) => (i === 0 ? {...k, pubkey: feePayerPubkey} : k));
    return new TransactionInstructionCtor({keys, programId: ix.programId, data: ix.data});
  });
}

// ---------------------------------------------------------------------
// Sponsorship cost recovery — closing the loop the fee-payer wallet's
// own header (Kivo backend's solana-fee-payer.js) explicitly leaves open:
// with the per-address/daily caps removed, this wallet keeps covering
// sponsored trades until it runs dry, with no other backstop. This
// section is what refills it, WITHOUT ever risking the trade it's
// supposed to be protecting — see the design contract below.
//
// Design, per real precedent (Kora/Circle Gas Station/Openfort docs —
// all recover cost with an SPL transfer to the fee payer's own account,
// executed INSIDE the same sponsored transaction, not a quote-time %):
//
//  1. RECOVER EXACTLY REAL COST, PLUS A NON-PROFIT BUFFER. The amount is
//     this transaction's own measured lamports cost (base fee + any
//     rent this fee payer is now funding — read from the ORIGINAL,
//     pre-rewrite instructions, not guessed), priced live via
//     walletPrices.ts's SOL/USD feed (so it tracks SOL's own volatility
//     instead of a stale $ constant), plus SPONSORSHIP_RECOVERY_BUFFER_PCT
//     — sized only to cover the eventual USDC->SOL conversion cost when
//     this wallet's accumulated USDC gets swept back into SOL, never a
//     margin on top of real cost. Explicit product decision: recovering
//     MORE than what sponsorship actually cost is the same "cheating"
//     the flat appFeeBpsForSponsoredTrade()/sponsoredFeeFloorUsd() path
//     in fees.ts already exists to avoid on the Relay-sponsorship side.
//
//  2. NEVER IN THE WAY OF THE TRADE. Recovery is denominated in USDC and
//     paid from whatever USDC the user's wallet already holds (checked
//     against a live balance, not assumed) — deliberately NOT tied to
//     this specific swap's own origin/destination currency, so it works
//     the same whether the swap is a Buy or a Sell, paid in USDC or in
//     anything else. If the user doesn't hold enough USDC, or ANYTHING
//     about the augmented transaction fails to simulate clean (a stale
//     balance snapshot, a compute-budget conflict, whatever), the whole
//     recovery attempt is dropped and the plain, already-working
//     sponsored transaction is sent instead — recovery is strictly
//     opportunistic, the trade succeeding is not.
//
//  3. MEASURE, DON'T GUESS, THE COMPUTE BUDGET. An added SPL transfer
//     costs real compute units Relay's own route never budgeted for
//     (https://57blocks.com/blog/deep-dive-into-resource-limitations-in-solana-development-cu-edition).
//     The augmented instruction set is simulated BEFORE it's ever
//     signed (sigVerify: false, replaceRecentBlockhash: true — the same
//     pattern Kivo backend's own coSignAsFeePayer already uses server-side)
//     and, only if that simulation comes back clean, its real
//     unitsConsumed is used to correct (or add) a SetComputeUnitLimit
//     instruction to ~110% of that measured value
//     (https://docs.chainstack.com/docs/solana-compute-budget) — never a
//     flat guessed number.
//
// The sponsor's own USDC associated token account is created lazily,
// idempotently, the first time it's needed — funded by the fee payer's
// OWN signature for its OWN account, so there's no user-funds risk in
// that half of it either.

const LAMPORTS_PER_SIGNATURE = 5000;
// Real SPL Token account size, verified against the SPL Token program's
// own account layout (same 165-byte constant already relied on
// elsewhere in this codebase's fee-sponsorship work) — the Associated
// Token Account program computes this rent internally via a CPI, so
// unlike SystemProgram.createAccount's own explicit `lamports` field
// (read directly from instruction data below), there's nothing to read
// off an ATA-Create instruction itself; this is what
// getMinimumBalanceForRentExemption is actually pricing.
const SPL_TOKEN_ACCOUNT_SPACE = 165;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
// ComputeBudgetInstruction enum's SetComputeUnitLimit variant.
const COMPUTE_BUDGET_SET_UNIT_LIMIT_DISCRIMINANT = 2;
// Not profit — see this section's own header, point 1. Sized to cover
// the real, if modest, cost of eventually converting this wallet's
// accumulated USDC back into the SOL it actually needs to keep
// sponsoring trades with.
const SPONSORSHIP_RECOVERY_BUFFER_PCT = 0.01;
// Simulate-then-correct margin over the REAL measured compute units —
// never a guessed absolute number. See this section's own header,
// point 3.
const COMPUTE_BUDGET_SAFETY_MULTIPLE = 1.1;

/**
 * Real lamports cost of sponsoring this specific transaction: the base
 * network fee (one signature per required signer) plus any account-rent
 * this fee payer is now funding, per the account-creation rewrite above.
 * Reads directly off the ORIGINAL (pre-rewrite) instructions — a
 * SystemProgram.createAccount/-WithSeed instruction's own `lamports`
 * field (the u64 immediately after the 4-byte discriminant, per
 * system_instruction.rs) already carries the exact rent-exempt amount
 * whoever built this route funded it with; an Associated Token Account
 * Create/CreateIdempotent instruction carries no such field (the program
 * computes it internally), so that case is priced via
 * `tokenAccountRentExemptLamports` — resolved once, live, by the caller
 * (connection.getMinimumBalanceForRentExemption), never hardcoded.
 * Pure and independently testable — no network I/O of its own.
 */
export function estimateSponsorshipLamportsCost(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  numRequiredSignatures: number,
  tokenAccountRentExemptLamports: number,
): number {
  let rentCost = 0;
  let needsTokenAccountRent = false;
  for (const ix of instructions) {
    const programId = ix.programId.toBase58();
    if (programId === SYSTEM_PROGRAM_ID && ix.data.length >= 12 && SYSTEM_ACCOUNT_CREATING_DISCRIMINANTS.has(ix.data.readUInt32LE(0))) {
      rentCost += Number(ix.data.readBigUInt64LE(4));
    } else if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      needsTokenAccountRent = true;
    }
  }
  if (needsTokenAccountRent) rentCost += tokenAccountRentExemptLamports;
  return Math.max(0, numRequiredSignatures) * LAMPORTS_PER_SIGNATURE + rentCost;
}

/**
 * Real cost -> USDC base units, live-priced (never a hardcoded $
 * estimate — SOL is too volatile for that, per the product decision
 * this implements) plus the non-profit conversion buffer. Pure — the
 * live price itself is fetched by the caller (walletPrices.ts) and
 * passed in, so this stays independently testable against fixed inputs.
 * Returns 0 (meaning: skip recovery, don't guess) whenever either input
 * isn't a real positive number.
 */
export function sponsorshipRecoveryUsdcUnits(lamportsCost: number, solPriceUsd: number): number {
  if (!(lamportsCost > 0) || !(solPriceUsd > 0)) return 0;
  const solCost = lamportsCost / 1_000_000_000;
  const recoveryUsd = solCost * solPriceUsd * (1 + SPONSORSHIP_RECOVERY_BUFFER_PCT);
  return Math.round(recoveryUsd * 10 ** ASSET_ONCHAIN_DECIMALS.USDC);
}

/**
 * Sets (or corrects) this instruction set's compute-unit budget to
 * `units`, IN PLACE OF any existing SetComputeUnitLimit instruction
 * Relay's own route may already include — two such instructions in one
 * transaction is a runtime error, not additive, so this replaces rather
 * than appends when one is already present. Prepends a new one
 * (ComputeBudget instructions are conventionally first, though the
 * runtime scans for them regardless of position) when none exists.
 * Pure, independently testable.
 */
export function withComputeUnitLimit(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  units: number,
  computeUnitLimitInstruction: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>,
): InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[] {
  const existingIndex = instructions.findIndex(ix => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM_ID && ix.data.length >= 1 && ix.data[0] === COMPUTE_BUDGET_SET_UNIT_LIMIT_DISCRIMINANT);
  if (existingIndex >= 0) {
    const copy = [...instructions];
    copy[existingIndex] = computeUnitLimitInstruction;
    return copy;
  }
  return [computeUnitLimitInstruction, ...instructions];
}

/**
 * Whoever is signing the user's half of a sponsored transaction — a
 * local Keypair (signAndSendRelaySolanaStep's own fallback) or Particle
 * MPC (signAndSendRelaySolanaStepViaParticle's own fallback, added
 * alongside the EVM/Solana cost-recovery work above). signAndSendSponsoredSolanaStep
 * below needs the SAME recovery/compute-budget logic regardless of
 * which one it is — this is the one seam that differs, so it's the one
 * thing abstracted, not a speculative interface for cases that don't
 * exist yet.
 */
export type SolanaTransactionSigner = {
  publicKey: InstanceType<typeof import('@solana/web3.js').PublicKey>;
  sign: (transaction: InstanceType<typeof import('@solana/web3.js').VersionedTransaction>) => Promise<InstanceType<typeof import('@solana/web3.js').VersionedTransaction>>;
};

// Exported so sendUsdc.ts's own Solana withdrawal can reuse this exact,
// already-tested fee-payer path on an "insufficient lamports" shortfall
// — same real gap trades used to have, same fix, no reason to duplicate
// the rewrite/sign/co-sign/broadcast logic (or its cost-recovery
// attempt, which stays opportunistic and harmless here too) a second
// time for a different caller.
export async function signAndSendSponsoredSolanaStep(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  lookupTables: InstanceType<typeof import('@solana/web3.js').AddressLookupTableAccount>[],
  signer: SolanaTransactionSigner,
  connection: InstanceType<typeof import('@solana/web3.js').Connection>,
  spendIntent?: SolanaSpendIntent,
): Promise<{signature: string; warnings: string[]}> {
  const [{Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram}, bs58Module, splToken] = await Promise.all([
    import('@solana/web3.js'),
    import('bs58'),
    import('@solana/spl-token'),
  ]);
  const bs58 = bs58Module.default;
  const tokenAccountReadConnection = new Connection(SOLANA_TOKEN_ACCOUNT_READ_RPC_URL, 'confirmed');
  const simulationConnection = new Connection(SOLANA_SIMULATION_RPC_URL, 'confirmed');
  const feePayerPubkey = new PublicKey(await getSolanaFeePayerPublicKey());
  // AccountNotFound at this stage is a fee-payer validation failure on
  // Solana. Read the sponsor balance from the standard RPC before asking
  // it to simulate the full trade, so a genuinely unfunded sponsor gets
  // a precise error instead of being misreported as a route failure.
  const sponsorBalance = await simulationConnection.getBalance(feePayerPubkey, 'confirmed');
  if (sponsorBalance <= 0) {
    throw new Error('Kivo fee sponsorship is temporarily unavailable because its Solana fee-payer wallet has no SOL. The sponsor needs a SOL top-up; the trade itself was not signed or sent.');
  }
  const rewrittenInstructions = rewriteAccountCreationFundingInstructions(instructions, feePayerPubkey, TransactionInstruction);

  const {blockhash} = await connection.getLatestBlockhash('confirmed');
  let finalInstructions = rewrittenInstructions;
  // USDC this transaction's own cost recovery adds on top of the trade —
  // allowed by the spend guard below as Kivo's, not the route's.
  let recoveryUnitsIncluded = 0n;

  // Cost recovery — strictly opportunistic, per this file's own header
  // above. Any failure anywhere in this block (no live price, no/not
  // enough USDC, a bad simulation) is caught and logged; it never
  // prevents the plain sponsored transaction below from going out.
  try {
    const usdcMintAddress = TOKEN_ADDRESSES.USDC?.solana;
    if (usdcMintAddress) {
      const probeMessage = new TransactionMessage({payerKey: feePayerPubkey, instructions: rewrittenInstructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables);
      const numRequiredSignatures = probeMessage.header.numRequiredSignatures;
      const usdcMint = new PublicKey(usdcMintAddress);
      const needsTokenAccountRent = instructions.some(ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID);
      const tokenAccountRentExemptLamports = needsTokenAccountRent ? await connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_SPACE) : 0;
      const lamportsCost = estimateSponsorshipLamportsCost(instructions, numRequiredSignatures, tokenAccountRentExemptLamports);

      const prices = await fetchWalletPrices().catch(() => ({}) as Record<string, number>);
      const recoveryUnits = sponsorshipRecoveryUsdcUnits(lamportsCost, prices.SOL ?? 0);

      if (recoveryUnits > 0) {
        const userUsdcAta = await splToken.getAssociatedTokenAddress(usdcMint, signer.publicKey);
        const userUsdcBalance = await connection.getTokenAccountBalance(userUsdcAta).catch(() => null);
        const userUsdcUnits = userUsdcBalance ? Number(userUsdcBalance.value.amount) : 0;

        if (userUsdcUnits >= recoveryUnits) {
          const sponsorUsdcAta = await splToken.getAssociatedTokenAddress(usdcMint, feePayerPubkey);
          const sponsorAtaInfo = await connection.getAccountInfo(sponsorUsdcAta);
          const candidateInstructions = [...rewrittenInstructions];
          if (!sponsorAtaInfo) {
            // The sponsor funds its OWN receiving account with its OWN
            // signature — no user funds touched by this instruction.
            candidateInstructions.push(splToken.createAssociatedTokenAccountInstruction(feePayerPubkey, sponsorUsdcAta, feePayerPubkey, usdcMint));
          }
          candidateInstructions.push(splToken.createTransferInstruction(userUsdcAta, sponsorUsdcAta, signer.publicKey, recoveryUnits));

          const candidateMessage = new TransactionMessage({payerKey: feePayerPubkey, instructions: candidateInstructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables);
          const candidateTransaction = new VersionedTransaction(candidateMessage);
          const simulation = await simulationConnection.simulateTransaction(candidateTransaction, {sigVerify: false, replaceRecentBlockhash: true});

          if (!simulation.value.err && typeof simulation.value.unitsConsumed === 'number') {
            const safeUnits = Math.ceil(simulation.value.unitsConsumed * COMPUTE_BUDGET_SAFETY_MULTIPLE);
            const computeUnitLimitInstruction = ComputeBudgetProgram.setComputeUnitLimit({units: safeUnits});
            finalInstructions = withComputeUnitLimit(candidateInstructions, safeUnits, computeUnitLimitInstruction);
            recoveryUnitsIncluded = BigInt(recoveryUnits);
          } else if (simulation.value.err) {
            console.warn('[sponsorshipRecovery] Augmented transaction did not simulate clean — sending the plain sponsored transaction instead:', JSON.stringify(simulation.value.err));
          }
        }
      }
    }
  } catch (err) {
    console.warn('[sponsorshipRecovery] Skipping cost recovery for this trade:', err instanceof Error ? err.message : String(err));
  }

  const message = new TransactionMessage({payerKey: feePayerPubkey, instructions: finalInstructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables);
  const unsignedTransaction = new VersionedTransaction(message);
  // The fee payer here is deliberately Kivo's own sponsor, not the
  // user — that's the whole point of this function. expectedSigner
  // still gets checked independently, so the user's own signature on
  // the real swap/transfer instructions remains required regardless of
  // who pays the fee.
  const warnings = assertSolanaTransactionMatchesIntent(unsignedTransaction, {
    expectedSigner: signer.publicKey.toBase58(),
    expectedFeePayer: feePayerPubkey.toBase58(),
    addressLookupTableAccounts: lookupTables,
  });
  // The semantic check (solanaSpendGuard.ts): the wallet's balances may
  // only change as the trade allows. Sponsorship moves who pays the fee,
  // not what the user may lose.
  if (spendIntent) {
    const usdcMintAddress = TOKEN_ADDRESSES.USDC?.solana;
    const extra = recoveryUnitsIncluded > 0n && usdcMintAddress ? [...(spendIntent.extra ?? []), {mint: usdcMintAddress, units: recoveryUnitsIncluded}] : spendIntent.extra;
    await assertSolanaSpendWithinIntentWeb3(simulationConnection, unsignedTransaction, signer.publicKey.toBase58(), {...spendIntent, extra}, tokenAccountReadConnection);
  }

  const transaction = await signer.sign(unsignedTransaction);

  if (!SOLANA_SPONSOR_FEE_URL) throw new Error('Kivo Solana fee sponsorship is not configured.');
  const res = await fetch(SOLANA_SPONSOR_FEE_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({transaction: Buffer.from(transaction.serialize()).toString('base64')}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {error?: string};
    throw new Error(body.error || 'Fee sponsorship is not available right now.');
  }
  const {data} = (await res.json()) as {data?: {transaction?: string}};
  if (!data?.transaction) throw new Error('Fee sponsorship is not available right now.');

  const signedTransaction = VersionedTransaction.deserialize(Buffer.from(data.transaction, 'base64'));
  const signature = bs58.encode(signedTransaction.signatures[0]);
  await connection.sendRawTransaction(signedTransaction.serialize());
  return {signature: await confirmSolanaSignature(connection, signature), warnings};
}

export async function signAndSendRelaySolanaStep(item: RelayTransactionStepItem, secretKeyBase58: string, spendIntent: SolanaSpendIntent): Promise<{signature: string; warnings: string[]}> {
  const [{Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction}, bs58Module] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  const bs58 = bs58Module.default;
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const tokenAccountReadConnection = new Connection(SOLANA_TOKEN_ACCOUNT_READ_RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));

  const instructions = (item.data?.instructions ?? []).map(
    ix =>
      new TransactionInstruction({
        keys: ix.keys.map(k => ({pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable})),
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, 'hex'),
      }),
  );
  const lookupTables = (
    await Promise.all((item.data?.addressLookupTableAddresses ?? []).map(addr => connection.getAddressLookupTable(new PublicKey(addr)).then(res => res.value)))
  ).filter((t): t is NonNullable<typeof t> => Boolean(t));

  const {blockhash} = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({payerKey: keypair.publicKey, instructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);

  // Real Solana pre-sign check (solanaTxIntent.ts) — was ported into
  // this repo but never actually called from the live signing path
  // (confirmed while auditing this file: no import of it existed here
  // at all). Runs on the exact object about to be signed, so a fee
  // payer that somehow isn't this wallet, or a hidden SPL Approve/
  // SetAuthority/CloseAccount instruction bundled into the swap, is
  // caught here instead of silently signed.
  const solanaWarnings = assertSolanaTransactionMatchesIntent(transaction, {
    expectedSigner: keypair.publicKey.toBase58(),
    addressLookupTableAccounts: lookupTables,
  });

  const localSigner: SolanaTransactionSigner = {
    publicKey: keypair.publicKey,
    sign: async tx => {
      tx.sign([keypair]);
      return tx;
    },
  };
  // The semantic check (solanaSpendGuard.ts), before anything is signed.
  // A wallet short of SOL can't be simulated as its own fee payer — that
  // case goes straight to Kivo's sponsored path, which runs the same
  // check with the sponsor paying.
  try {
    await assertSolanaSpendWithinIntentWeb3(connection, transaction, keypair.publicKey.toBase58(), spendIntent, tokenAccountReadConnection);
  } catch (guardErr) {
    if (!isInsufficientSolSimulation(guardErr)) throw guardErr;
    try {
      return await signAndSendSponsoredSolanaStep(instructions, lookupTables, localSigner, connection, spendIntent);
    } catch (sponsorErr) {
      const sponsorMessage = sponsorErr instanceof Error ? sponsorErr.message : String(sponsorErr);
      throw new Error(`This wallet doesn't have enough SOL for this route's network fees, and fee sponsorship didn't cover it: ${sponsorMessage}`);
    }
  }

  transaction.sign([keypair]);
  const signature = bs58.encode(transaction.signatures[0]);

  try {
    await connection.sendRawTransaction(transaction.serialize());
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const lamportsMatch = errorMessage.match(/insufficient lamports (\d+), need (\d+)/i);
    if (lamportsMatch) {
      // Nothing was broadcast yet (this is our own pre-flight simulate
      // rejecting it) — safe to retry with Kivo's fee payer covering
      // the shortfall instead of failing outright. Only falls through
      // to the plain "add more SOL" message if sponsorship itself isn't
      // available or also fails.
      try {
        return await signAndSendSponsoredSolanaStep(instructions, lookupTables, localSigner, connection, spendIntent);
      } catch (sponsorErr) {
        const haveSol = Number(lamportsMatch[1]) / 1e9;
        const needSol = Number(lamportsMatch[2]) / 1e9;
        // Surface the real sponsorship failure instead of always
        // blaming the user's balance — sponsorship can fail for reasons
        // that have nothing to do with SOL (missing config, rate limit,
        // a rejected/failed simulation), and hiding that behind "add
        // more SOL" makes every one of those look identical and
        // impossible to debug.
        const sponsorMessage = sponsorErr instanceof Error ? sponsorErr.message : String(sponsorErr);
        throw new Error(
          `This wallet has ~${haveSol.toFixed(4)} SOL, short of the ~${needSol.toFixed(4)} SOL this route needs, and fee sponsorship didn't cover it: ${sponsorMessage}`,
        );
      }
    }
    try {
      await connection.sendRawTransaction(transaction.serialize(), {skipPreflight: true});
      const confirmedSignature = await confirmSolanaSignature(connection, signature);
      return {signature: confirmedSignature, warnings: solanaWarnings};
    } catch {
      // The retry itself failed to submit — fall through to a direct
      // landed-check rather than trusting the simulation's rejection.
    }
    let landed = false;
    for (let attempt = 0; attempt < 3 && !landed; attempt++) {
      if (attempt > 0) await new Promise<void>(r => setTimeout(r, 700));
      const {value} = await connection.getSignatureStatuses([signature]).catch(() => ({value: [null]}));
      const status = value?.[0];
      if (status && status.err == null && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) landed = true;
    }
    if (!landed) {
      (err as {signature?: string}).signature = signature;
      throw err;
    }
  }
  return {signature: await confirmSolanaSignature(connection, signature), warnings: solanaWarnings};
}

/**
 * Same instruction/lookup-table/blockhash assembly as
 * signAndSendRelaySolanaStep above, but for a Google-login session:
 * there's no local secret key to sign with, so the built (unsigned)
 * VersionedTransaction is serialized and handed to Particle's own MPC
 * signer instead — via signAndSendSolanaTransactionViaParticle
 * (sign-and-broadcast in one call) on the normal, sufficient-balance
 * path, or via the sign-only signSolanaTransactionViaParticle when the
 * fee-payer fallback below needs to add the sponsor's own signature
 * before anything broadcasts.
 *
 * The local-signing function's own fallback detects a shortfall by
 * catching the RPC's "insufficient lamports X, need Y" rejection text
 * AFTER attempting to submit — Particle's own sign-and-send collapses
 * signing and broadcast into one call with no confirmed guarantee its
 * error surface preserves that same RPC text, so this path checks
 * BEFORE ever calling Particle instead: compute this transaction's own
 * real lamports need with the exact same estimateSponsorshipLamportsCost
 * math the fee-payer's own cost-recovery uses, and compare it against a
 * real getBalance() read. Same outcome (sponsor when short, don't when
 * not), a more robust trigger for this specific signer.
 */
async function signAndSendRelaySolanaStepViaParticle(item: RelayTransactionStepItem, solanaAddress: string, spendIntent: SolanaSpendIntent): Promise<{signature: string; warnings: string[]}> {
  const {Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction} = await import('@solana/web3.js');
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const tokenAccountReadConnection = new Connection(SOLANA_TOKEN_ACCOUNT_READ_RPC_URL, 'confirmed');
  const payerKey = new PublicKey(solanaAddress);

  const instructions = (item.data?.instructions ?? []).map(
    ix =>
      new TransactionInstruction({
        keys: ix.keys.map(k => ({pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable})),
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, 'hex'),
      }),
  );
  const lookupTables = (
    await Promise.all((item.data?.addressLookupTableAddresses ?? []).map(addr => connection.getAddressLookupTable(new PublicKey(addr)).then(res => res.value)))
  ).filter((t): t is NonNullable<typeof t> => Boolean(t));

  const {blockhash} = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({payerKey, instructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);

  // Same real pre-sign check as the local-signing path above, run on
  // the exact object about to be serialized and handed to Particle.
  const solanaWarnings = assertSolanaTransactionMatchesIntent(transaction, {
    expectedSigner: solanaAddress,
    addressLookupTableAccounts: lookupTables,
  });
  // The semantic check (solanaSpendGuard.ts), before Particle signs. A
  // wallet short of SOL can't be simulated as its own fee payer; the
  // balance check below then takes the sponsored path, which runs the
  // same check with the sponsor paying.
  let spendVerified = false;
  try {
    await assertSolanaSpendWithinIntentWeb3(connection, transaction, solanaAddress, spendIntent, tokenAccountReadConnection);
    spendVerified = true;
  } catch (guardErr) {
    if (!isInsufficientSolSimulation(guardErr)) throw guardErr;
  }

  // Pre-flight balance check — see this function's own header for why
  // this replaces the local-signing path's catch-the-RPC-error approach
  // for this specific signer.
  try {
    const needsTokenAccountRent = instructions.some(ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID);
    const tokenAccountRentExemptLamports = needsTokenAccountRent ? await connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_SPACE) : 0;
    const requiredLamports = estimateSponsorshipLamportsCost(instructions, message.header.numRequiredSignatures, tokenAccountRentExemptLamports);
    const actualBalance = await connection.getBalance(payerKey, 'confirmed');

    if (actualBalance < requiredLamports) {
      const particleSigner: SolanaTransactionSigner = {
        publicKey: payerKey,
        sign: async tx => {
          const {signSolanaTransactionViaParticle} = await import('../wallet/particleSigning.ts');
          const signedBytes = await signSolanaTransactionViaParticle(tx.serialize());
          return VersionedTransaction.deserialize(signedBytes);
        },
      };
      try {
        return await signAndSendSponsoredSolanaStep(instructions, lookupTables, particleSigner, connection, spendIntent);
      } catch (sponsorErr) {
        const sponsorMessage = sponsorErr instanceof Error ? sponsorErr.message : String(sponsorErr);
        throw new Error(
          `This wallet has ~${(actualBalance / 1e9).toFixed(4)} SOL, short of the ~${(requiredLamports / 1e9).toFixed(4)} SOL this route needs, and fee sponsorship didn't cover it: ${sponsorMessage}`,
        );
      }
    }
  } catch (err) {
    // A failure in the BALANCE CHECK itself (an RPC hiccup reading
    // getBalance/getMinimumBalanceForRentExemption, say) is not the same
    // as a confirmed shortfall — falls through to the normal path below
    // rather than wrongly assuming insufficient funds. A genuine
    // shortfall's own sponsorship failure (the throw inside the try
    // above) is a real, final error and must propagate, not be
    // swallowed here.
    if (err instanceof Error && /^This wallet has ~/.test(err.message)) throw err;
  }

  // Never hand Particle a transaction the spend guard couldn't verify.
  if (!spendVerified) {
    throw new Error("This wallet doesn't have enough SOL for this route's network fees, and fee sponsorship couldn't be checked — try again in a moment.");
  }
  const serialized = transaction.serialize();

  // Dynamic import, not a static one — see sendRelayEvmStepViaParticle's
  // own comment above for why (this file is also imported directly by
  // scripts/verify-execute-relay-quote.mjs's plain-Node offline checks).
  const {signAndSendSolanaTransactionViaParticle} = await import('../wallet/particleSigning.ts');
  const signature = await signAndSendSolanaTransactionViaParticle(serialized);

  const deadline = Date.now() + 90_000;
  for (;;) {
    const {value} = await connection.getSignatureStatuses([signature]);
    const status = value?.[0];
    if (status) {
      if (status.err) {
        const error = new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
        (error as {signature?: string}).signature = signature;
        throw error;
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return {signature, warnings: solanaWarnings};
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for transaction ${signature} to confirm.`);
    await new Promise<void>(r => setTimeout(r, 1200));
  }
}

export type ExecuteRelayQuoteResult = {txHashes: string[]; warnings: string[]};

// Real gap this closes: a multi-step Relay quote (more than one
// transaction to sign/broadcast) that fails on step 2+ used to just
// throw, discarding every hash already pushed onto the local txHashes
// array from steps that landed for real on-chain — a caller's catch
// block only ever saw the error, never what had already gone through.
// That's the exact same "moved for real but no record of it" gap
// TokenTradeScreen.tsx's own consolidateIntoPayOrigin closed for its
// own multi-leg loop; this closes it at the source, for every caller.
//
// Deliberately a property tagged onto the SAME thrown error object
// (never a new Error wrapping it) — preserves the original's identity
// exactly, so every existing `instanceof TransactionIntentError` (or
// any other) check downstream keeps working unchanged. Purely additive
// metadata, not a new control-flow path.
const PARTIAL_TX_HASHES_KEY = 'kivoPartialTxHashes';

function attachPartialTxHashes(err: unknown, hashes: string[]): void {
  if (hashes.length === 0 || !err || typeof err !== 'object') return;
  (err as Record<string, unknown>)[PARTIAL_TX_HASHES_KEY] = hashes;
}

/** Reads back the hashes attachPartialTxHashes recorded, or an empty array if this error never carried any (the common case — most failures happen before anything broadcasts). */
export function getPartialTxHashes(err: unknown): string[] {
  if (!err || typeof err !== 'object') return [];
  const value = (err as Record<string, unknown>)[PARTIAL_TX_HASHES_KEY];
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string') : [];
}

/**
 * Validates a Relay quote without signing or broadcasting anything.
 * Multi-source Fomo buys call this for EVERY leg before the first leg is
 * allowed to broadcast. That turns a per-leg safety check into a whole
 * trade preflight: one unsupported chain, unsafe Solana cleanup instruction,
 * or unavailable Relay gasless deployment cannot appear only after an
 * earlier source leg has already landed on-chain.
 */
export async function preflightRelayQuoteExecution(quote: RelayQuote, session: DerivedAccounts): Promise<void> {
  const tagged = intentForQuote(quote);
  if (!tagged) throw new Error('This quote has no recorded intent to check against — refusing to sign.');
  if (Date.now() - tagged.quotedAt > RELAY_QUOTE_MAX_AGE_MS) throw new Error('This quote is too old to sign safely — get a fresh quote and try again.');

  const pendingItems: RelayTransactionStepItem[] = [];
  for (const step of quote.steps ?? []) {
    if (step.kind !== 'transaction') {
      throw new Error(`Unsupported Relay step kind "${step.kind}" — only transaction steps are handled by this app.`);
    }
    for (const item of step.items) if (item.status !== 'complete') pendingItems.push(item);
  }
  assertQuoteSafeToSign(quote, tagged.intent, pendingItems);

  if (session.authMethod === 'google' && pendingItems.some(item => !isSolanaShaped(item))) {
    throw new Error('Relay gasless EVM trading is not available for this Google/Particle wallet on this route yet.');
  }

  for (const item of pendingItems) {
    if (isSolanaShaped(item)) continue;
    const chainId = item.data?.chainId;
    if (!chainId) throw new Error('The routing service returned a transaction with no chain.');
    const viemChain = viemChainForChainId(chainId);
    if (!viemChain) throw new Error(`No EVM chain configured for chain id ${chainId}.`);
    const owner = privateKeyToAccount(session.evm.privateKey as `0x${string}`);
    await preflightRelayGaslessEvm({
      chain: viemChain,
      fromAddress: owner.address,
      account: owner,
    });
  }
}
/**
 * Executes a quote from getRelayQuote(): checks the pre-sign firewall
 * against every still-pending item BEFORE signing the first one (so a
 * quote whose LAST transaction is the hostile one is refused before the
 * first is broadcast), then signs and sends each pending item with the
 * session's own key, then polls Relay until the destination side is
 * reported complete. Throws TransactionIntentError (from
 * txIntentFirewall.ts) if the firewall blocks; throws a plain Error for
 * anything else (network, insufficient balance, on-chain revert).
 *
 * EVM transaction items are executed through Relay's sponsored
 * Calibur/EIP-7702 batch path. There is deliberately no native-gas fallback:
 * if Relay cannot sponsor the route, the trade stops before that EVM batch
 * is broadcast. Google/Particle EVM sessions are rejected until their signer
 * exposes the same Relay-compatible authorization/signature primitives.
 */
export async function executeRelayQuote(
  quote: RelayQuote,
  session: DerivedAccounts,
  onStep?: (step: ExecuteStep) => void,
  options?: {
    useGaslessTrading?: boolean;
    /**
     * Re-runs the exact same getRelayQuote() call the caller already made
     * to build `quote`, for the ONE case where retrying the identical
     * calldata isn't enough (see isTransientRevert below): the pool moved
     * and stayed moved, not just a momentary blip. Only ever invoked
     * before anything has broadcast (txHashes.length === 0), and at most
     * once per call — the recursive re-entry below drops this option so
     * a persistently-reverting route can't loop forever re-quoting.
     */
    requote?: () => Promise<RelayQuote>;
  },
): Promise<ExecuteRelayQuoteResult> {
  const tagged = intentForQuote(quote);
  if (!tagged) {
    throw new Error('This quote has no recorded intent to check against — refusing to sign.');
  }
  if (Date.now() - tagged.quotedAt > RELAY_QUOTE_MAX_AGE_MS) {
    throw new Error('This quote is too old to sign safely — get a fresh quote and try again.');
  }

  // This whole quote spends from exactly one origin currency (Relay's
  // own currencyIn) — read once here and threaded into every EVM step
  // sender below purely as an allowance-recovery fallback (see
  // toppedUpOriginAllowance's own header): a real, reproduced BNB Chain
  // Convert failure (TransferFromFailed() on Relay's Depository) traced
  // to the deposit step pulling this exact token without enough prior
  // approval. Left undefined (recovery becomes a no-op) whenever the
  // origin is a native coin, not an ERC-20 — matches this codebase's own
  // zero-address native placeholder (chainData.ts's NATIVE_TOKEN_ADDRESS).
  const originCurrencyAddress = quote.details?.currencyIn?.currency?.address;
  const originToken =
    originCurrencyAddress && originCurrencyAddress.toLowerCase() !== '0x0000000000000000000000000000000000000000'
      ? (originCurrencyAddress as `0x${string}`)
      : undefined;
  const originAmountRaw = quote.details?.currencyIn?.amount;
  let originAmount: bigint | undefined;
  try {
    originAmount = originAmountRaw ? BigInt(originAmountRaw) : undefined;
  } catch {
    originAmount = undefined;
  }

  onStep?.('build');
  const steps = quote.steps ?? [];
  const pendingItems: RelayTransactionStepItem[] = [];
  let requestId: string | undefined;
  for (const step of steps) {
    if (step.kind !== 'transaction') {
      throw new Error(`Unsupported Relay step kind "${step.kind}" — only transaction steps are handled by this app.`);
    }
    requestId = requestId ?? step.requestId;
    for (const item of step.items) {
      if (item.status !== 'complete') pendingItems.push(item);
    }
  }

  // Diagnostic only, no effect on execution — useful when a Relay quote
  // contains multiple transaction items and one later item is the source of
  // an execution failure.
  console.warn(
    '[executeRelayQuote] pendingItems:',
    pendingItems.map(item => ({
      chainId: item.data?.chainId,
      to: item.data?.to,
      selector: typeof item.data?.data === 'string' ? item.data.data.slice(0, 10) : undefined,
      value: item.data?.value,
    })),
  );

  const warnings = assertQuoteSafeToSign(quote, tagged.intent, pendingItems);
  for (const warning of warnings) {
    console.warn(`[txIntentFirewall] ${warning}`);
  }

  onStep?.('signing');
  const isGoogleSession = session.authMethod === 'google';
  const txHashes: string[] = [];
  try {
    // Relay's official Calibur/EIP-7702 flow batches the quote's origin-chain
    // transaction items (typically approve + deposit) into ONE atomic
    // sponsored execute call. Kivo previously submitted each item as its
    // own /execute request. That was a fundamental mismatch with the
    // documented Relay gasless flow and could leave an approval on-chain
    // before the deposit or make a multi-step quote fail halfway through.
    //
    // Solana remains instruction-bundle based and is executed as its own
    // transaction. EVM items are batched only when they are consecutive
    // items for the same chain, preserving Relay's returned ordering.
    type EvmBatch = {
      chainId: number;
      items: RelayTransactionStepItem[];
    };
    const units: Array<
      | {kind: 'solana'; item: RelayTransactionStepItem}
      | {kind: 'evm'; batch: EvmBatch}
    > = [];

    for (const item of pendingItems) {
      if (isSolanaShaped(item)) {
        units.push({kind: 'solana', item});
        continue;
      }
      const chainId = item.data?.chainId;
      if (!chainId) throw new Error('The routing service returned a transaction with no chain.');
      const last = units[units.length - 1];
      if (last?.kind === 'evm' && last.batch.chainId === chainId) {
        last.batch.items.push(item);
      } else {
        units.push({kind: 'evm', batch: {chainId, items: [item]}});
      }
    }

    for (const unit of units) {
      if (unit.kind === 'solana') {
        const item = unit.item;
        const spendIntent = {
          ...solanaSpendIntentFor(tagged.intent),
          ...await solanaOutputVerificationFor(quote, tagged.intent, session.solana.address),
        };
        const {signature, warnings: solanaStepWarnings} = isGoogleSession
          ? await signAndSendRelaySolanaStepViaParticle(item, session.solana.address, spendIntent)
          : await signAndSendRelaySolanaStep(item, session.solana.privateKey, spendIntent);
        txHashes.push(signature);
        for (const warning of solanaStepWarnings) {
          console.warn(`[solanaTxIntent] ${warning}`);
        }
        warnings.push(...solanaStepWarnings);
        continue;
      }

      const chainId = unit.batch.chainId;
      const viemChain = viemChainForChainId(chainId);
      if (!viemChain) throw new Error(`No EVM chain configured for chain id ${chainId}.`);
      if (isGoogleSession) {
        // Particle's current RN signing surface does not expose the
        // EIP-7702 authorization + Calibur EIP-712 signing primitives used
        // by Relay's official full-subsidy EOA flow. Never replace this with
        // a normal eth_sendTransaction: that would reintroduce native-gas
        // requirements and violate Kivo's Fomo-style execution contract.
        throw new Error('Relay gasless EVM trading is not available for this Google/Particle wallet on this route yet.');
      }

      const owner = privateKeyToAccount(session.evm.privateKey as `0x${string}`);
      const calls = unit.batch.items.map(item => ({
        to: item.data?.to as `0x${string}`,
        value: item.data?.value ? BigInt(item.data.value) : 0n,
        data: (item.data?.data || '0x') as `0x${string}`,
      }));

      const relayResult = await sendEvmCallsViaRelayGasless({
        chain: viemChain,
        fromAddress: owner.address,
        account: owner,
        calls,
        requestId,
      });
      txHashes.push(relayResult.hash);
    }
  } catch (err) {
    attachPartialTxHashes(err, txHashes);
    throw err;
  }

  if (requestId) {
    onStep?.('filling');
    await pollRelayStatus(requestId);
  }
  onStep?.('done');
  return {txHashes, warnings};
}
