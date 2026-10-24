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

import {markMaybeBroadcast, solanaSubmitDefinitelyRejected} from './broadcastState.ts';
import {privateKeyToAccount} from 'viem/accounts';
import {Buffer} from 'buffer';
import {viemChainForChainId} from './chainRegistry.ts';
import {assertQuoteSafeToSign, type TransactionIntent} from './txIntentFirewall.ts';
import {assertSolanaTransactionMatchesIntent} from './solanaTxIntent.ts';
import {solanaOutputVerificationFor} from './solanaOutputGuard.ts';
import {recordDiagnosticEvent} from '../../src/debug/diagnosticLog';
import {SOLANA_NATIVE_SPEND, assertSolanaSpendWithinIntentWeb3, isInsufficientSolSimulation, SolanaSpendGuardError, type SolanaSpendIntent} from './solanaSpendGuard.ts';
import {intentForQuote, type RelayQuote, type RelayTransactionStepItem} from './relayQuote.ts';
import {TOKEN_ADDRESSES, ASSET_ONCHAIN_DECIMALS, ARC_USDC, MAINNET_CHAIN_IDS} from './chainData.ts';
import {RelayGaslessPendingError, preflightRelayGaslessEvm, sendEvmCallsViaRelayGasless} from './relayGaslessEvm.ts';
import {fetchWalletPrices} from './walletPrices.ts';
import type {DerivedAccounts} from '../wallet/keys';
import {
  associatedTokenAccountTargets, isTokenCloseAccount, MAX_SPONSOR_FUNDED_CREATIONS, rentExemptLamports, rewriteAccountCreationFundingInstructions,
  sponsorFundedRent, sponsorFundedToken2022Accounts, sponsorFundedWsolAccounts, systemCreateLamports, tokenAccountAmount, withCloseDestination,
  CLASSIC_TOKEN_ACCOUNT_SPACE, TOKEN_2022_ATA_MIN_SPACE,
} from './solanaAccountCreation.ts';

// Shared by the remaining Relay instruction validation paths.
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const RELAY_STATUS_URL = 'https://api.relay.link/intents/status/v3';
export const SOLANA_RPC_URL = 'https://rpc.solanatracker.io/public';
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
// Public address of Kivo's configured sponsor wallet; safe fallback if the lookup endpoint is temporarily unavailable.
const SOLANA_SPONSOR_FEE_URL: string | null = 'https://kivotrade.site/api/solana/sponsor-fee';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
// Kivo's Solana sponsor (fee payer). Was mistyped (…LHKmN…) before; this is the real wallet.
const SOLANA_FEE_PAYER_FALLBACK_PUBLIC_KEY = '2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';
let cachedSolanaFeePayerPublicKey: string | null = null;
export async function getSolanaFeePayerPublicKey(): Promise<string> {
  if (cachedSolanaFeePayerPublicKey) return cachedSolanaFeePayerPublicKey;
  if (!SOLANA_FEE_PAYER_URL) throw new Error('Kivo Solana fee sponsorship is not configured.');

  // Cloudflare may briefly serve a stale error after sponsor-secret changes.
  // Bypass intermediary caching and retry once before blocking the trade.
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${SOLANA_FEE_PAYER_URL}?_kivoSponsorCheck=${Date.now()}-${attempt}`, {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });
      const responseText = await res.text();
      if (!res.ok) {
        lastFailure = new Error(`HTTP ${res.status}`);
        continue;
      }

      let payload: {data?: {publicKey?: string}};
      try {
        payload = JSON.parse(responseText) as {data?: {publicKey?: string}};
      } catch {
        lastFailure = new Error('invalid JSON response');
        continue;
      }
      if (typeof payload.data?.publicKey !== 'string' || !payload.data.publicKey) {
        lastFailure = new Error('response did not include a public key');
        continue;
      }

      cachedSolanaFeePayerPublicKey = payload.data.publicKey;
      return cachedSolanaFeePayerPublicKey;
    } catch (error) {
      lastFailure = error;
    }
  }

  // The public key is not secret. Falling back lets the sponsor endpoint
  // make the authoritative decision; it still verifies the configured
  // private key and refuses to sign if it does not match this wallet.
  void recordDiagnosticEvent('solanaSponsor.fee-payer-fallback', lastFailure);
  cachedSolanaFeePayerPublicKey = SOLANA_FEE_PAYER_FALLBACK_PUBLIC_KEY;
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

export {solanaOutputVerificationFor};

export type RelaySettlement = 'success' | 'pending' | 'refunded';

/**
 * Waits for Relay to settle a request that was already broadcast. A slow
 * fill is NOT a failure: after the timeout the trade is reported as pending
 * (it may still land), never as failed, so the user doesn't retry and buy twice.
 */
async function pollRelayStatus(requestId: string, {intervalMs = 2000, timeoutMs = 10 * 60 * 1000}: {intervalMs?: number; timeoutMs?: number} = {}): Promise<RelaySettlement> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${RELAY_STATUS_URL}?requestId=${requestId}`);
      if (res.ok) {
        const data = (await res.json()) as {status?: string; failReason?: string};
        if (data.status === 'success') return 'success';
        if (data.status === 'refund' || data.status === 'refunded') return 'refunded';
        // Relay's documented failReason (e.g. SLIPPAGE, EXECUTION_REVERTED); "N/A"/"UNKNOWN" add nothing.
        const reason = data.failReason && !/^(N\/A|UNKNOWN)$/i.test(data.failReason) ? ` (${data.failReason.replace(/_/g, ' ').toLowerCase()})` : '';
        if (data.status === 'failure') throw new Error(`Relay reported this trade failed${reason} — check the requestId on relay.link for details.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Relay reported')) throw error;
      // Network blip while polling: keep waiting.
    }
    await new Promise<void>(r => setTimeout(r, intervalMs));
  }
  return 'pending';
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
    // A failed status read is not a failed transaction: keep polling until the deadline.
    const {value} = await connection.getSignatureStatuses([signature]).catch(() => ({value: [null]}));
    const status = value?.[0];
    if (status) {
      if (status.err) {
        const error = new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
        (error as {signature?: string}).signature = signature;
        throw error;
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return signature;
    }
    if (Date.now() >= deadline) throw markMaybeBroadcast(new Error(`Transaction ${signature} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature});
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
export {rewriteAccountCreationFundingInstructions} from './solanaAccountCreation.ts';

// ---------------------------------------------------------------------
// Sponsorship rent repayment.
//
// Kivo's sponsor pays every sponsored transaction's network and priority fee
// (Kivo's own cost, covered by its trading fee). It also funds the rent of
// new token accounts the route creates, and must get that back in the SAME
// transaction: a token account's rent goes to its owner when they close it,
// so unrepaid rent is free SOL. Kivo's server (web/server/solanaSponsor.ts)
// refuses to co-sign otherwise, counting each sponsor-funded account at its
// worst-case rent (sponsorFundedRent in solanaAccountCreation.ts mirrors it).
//
//  1. Accounts that already exist keep the user as (no-op) payer, so only
//     new accounts are counted. If the lookup fails, all are assumed new.
//  2. A new WSOL account the route only uses in passing (USDC -> SOL ->
//     token) is closed back to the sponsor when a simulation proves that
//     returns exactly its rent and nothing of the user's: no repayment needed.
//  3. Everything else (rent + any SOL top-up) is repaid at cost: in USDC
//     (live SOL price, the higher of CoinGecko and Jupiter, plus
//     SPONSORSHIP_RECOVERY_BUFFER_PCT) when the wallet can, else in SOL.
//     If it can do neither, nothing is signed and the user is told why.
//  4. The final instruction set is simulated and its real compute units
//     (+10%) set as the limit, since the repayment transfer costs compute
//     the route never budgeted for.

const LAMPORTS_PER_SIGNATURE = 5000;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
// ComputeBudgetInstruction enum's SetComputeUnitLimit variant.
const COMPUTE_BUDGET_SET_UNIT_LIMIT_DISCRIMINANT = 2;
// Covers price differences between Kivo's server and this app's SOL price,
// and converting the USDC back into SOL. No Kivo margin.
const SPONSORSHIP_RECOVERY_BUFFER_PCT = 0.03;
const RECOVERY_MULTIPLIER = 1 + SPONSORSHIP_RECOVERY_BUFFER_PCT;
// Simulate-then-correct margin over the REAL measured compute units.
const COMPUTE_BUDGET_SAFETY_MULTIPLE = 1.1;

/** Rent of each new token account an ATA create in this list makes, by token program (classic 165 bytes, Token-2022 at least 170). */
function ataCreateRentLamports(ix: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>): number {
  return rentExemptLamports(ix.keys[5]?.pubkey.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? CLASSIC_TOKEN_ACCOUNT_SPACE : TOKEN_2022_ATA_MIN_SPACE);
}

/**
 * Real lamports cost of this transaction for whoever pays it: the base
 * network fee (one signature per required signer), the priority fee, and the
 * rent of every account it creates. System CreateAccount/-WithSeed carry
 * their lamports (WithSeed after the variable-length seed); an Associated
 * Token Account create is priced by its token program. `existingAccounts`
 * are token accounts that already exist (their idempotent create is free);
 * when unknown, every create is assumed new (worst case).
 * Pure and independently testable: no network I/O of its own.
 */
export function estimateSponsorshipLamportsCost(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  numRequiredSignatures: number,
  existingAccounts: ReadonlySet<string> = new Set(),
): number {
  let rentCost = 0;
  const seen = new Set<string>();
  for (const ix of instructions) {
    const created = systemCreateLamports(ix);
    if (created !== null) {
      rentCost += created;
      continue;
    }
    if (ix.programId.toBase58() !== ASSOCIATED_TOKEN_PROGRAM_ID || ix.keys.length < 6) continue;
    const target = associatedTokenAccountTargets([ix])[0];
    if (!target || seen.has(target) || existingAccounts.has(target)) continue;
    seen.add(target);
    rentCost += ataCreateRentLamports(ix);
  }
  return Math.max(0, numRequiredSignatures) * LAMPORTS_PER_SIGNATURE + rentCost + priorityFeeLamports(instructions);
}

// ComputeBudget SetComputeUnitPrice variant (u64 micro-lamports per unit).
const COMPUTE_BUDGET_SET_UNIT_PRICE_DISCRIMINANT = 3;
// The runtime's default compute budget when no SetComputeUnitLimit is given.
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * The priority fee the fee payer is charged: SetComputeUnitPrice
 * (micro-lamports per unit) x the unit limit. Routes often set a high
 * price, so this can be most of a sponsored transaction's cost.
 */
export function priorityFeeLamports(instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[]): number {
  let price = 0n;
  let limit: number | null = null;
  let others = 0;
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) { others++; continue; }
    if (ix.data[0] === COMPUTE_BUDGET_SET_UNIT_PRICE_DISCRIMINANT && ix.data.length >= 9) price = ix.data.readBigUInt64LE(1);
    if (ix.data[0] === COMPUTE_BUDGET_SET_UNIT_LIMIT_DISCRIMINANT && ix.data.length >= 5) limit = ix.data.readUInt32LE(1);
  }
  const units = BigInt(Math.min(MAX_COMPUTE_UNITS, limit ?? others * DEFAULT_UNITS_PER_INSTRUCTION));
  return Number((price * units + 999_999n) / 1_000_000n);
}

/**
 * Lamports -> USDC base units at `solPriceUsd`, plus the conversion buffer,
 * rounded up. Returns 0 (skip, never guess) when either input isn't a real
 * positive number. Pure.
 */
export function sponsorshipRecoveryUsdcUnits(lamportsCost: number, solPriceUsd: number): number {
  if (!(lamportsCost > 0) || !(solPriceUsd > 0)) return 0;
  const solCost = lamportsCost / 1_000_000_000;
  const recoveryUsd = solCost * solPriceUsd * RECOVERY_MULTIPLIER;
  return Math.ceil(recoveryUsd * 10 ** ASSET_ONCHAIN_DECIMALS.USDC);
}

const REPAYMENT_PRICE_TTL_MS = 60_000;
let cachedRepaymentSolPrice: {usd: number; at: number} | null = null;
/**
 * SOL/USD for USDC rent repayment: the HIGHER of CoinGecko and Jupiter,
 * like Kivo's server, which values the USDC at its own highest price.
 * 0 when neither answers.
 */
export async function sponsorRepaymentSolPriceUsd(): Promise<number> {
  if (cachedRepaymentSolPrice && Date.now() - cachedRepaymentSolPrice.at < REPAYMENT_PRICE_TTL_MS) return cachedRepaymentSolPrice.usd;
  const [coingecko, jupiter] = await Promise.all([
    fetchWalletPrices().then(prices => prices.SOL ?? 0).catch(() => 0),
    fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`)
      .then(res => (res.ok ? res.json() : null))
      .then(body => Number((body as Record<string, {usdPrice?: number}> | null)?.[WSOL_MINT]?.usdPrice) || 0)
      .catch(() => 0),
  ]);
  const usd = Math.max(coingecko, jupiter);
  if (usd > 0) cachedRepaymentSolPrice = {usd, at: Date.now()};
  return usd;
}

/** USDC base units that repay `lamports` of sponsor-funded rent (0 when no price is available). */
export async function sponsorRepaymentUsdcUnits(lamports: number): Promise<bigint> {
  return BigInt(sponsorshipRecoveryUsdcUnits(lamports, await sponsorRepaymentSolPriceUsd()));
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
/** Matches the server's cap (web/server/solanaSponsor.ts MAX_SPONSOR_TOPUP_LAMPORTS). */
const MAX_SPONSOR_TOPUP_LAMPORTS = 3_000_000;

/**
 * Kivo's own fee wallet can't be sponsored (Relay's depositFeePayer and Kivo's
 * sponsor both require a different wallet), so it pays its own way. When it
 * is short, say exactly what the route needs instead of a generic message.
 */
async function feeWalletShortfallError(
  connection: InstanceType<typeof import('@solana/web3.js').Connection>,
  wallet: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  errorText: string,
): Promise<Error | null> {
  if (wallet.toBase58() !== await getSolanaFeePayerPublicKey().catch(() => '')) return null;
  const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4)} SOL`;
  let sentByRoute = 0;
  let newAccounts = 0;
  for (const ix of instructions) {
    const program = ix.programId.toBase58();
    if (program === '11111111111111111111111111111111' && ix.data.length >= 12 && ix.data.readUInt32LE(0) === 2 && ix.keys[0]?.pubkey.equals(wallet)) {
      sentByRoute += Number(ix.data.readBigUInt64LE(4));
    }
    if (program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') newAccounts++;
  }
  const have = await connection.getBalance(wallet, 'confirmed').catch(() => null);
  const need = errorText.match(/need (\d+)/i);
  const parts = [`new token accounts ~${sol(newAccounts * 2_039_280)}`, `SOL the route sends ~${sol(sentByRoute)}`];
  const total = need ? Number(need[1]) : newAccounts * 2_039_280 + sentByRoute + 10_000;
  return new Error(`This is Kivo's fee wallet, so it pays its own fees. This route needs about ${sol(total)} (${parts.join(', ')})${have === null ? '' : `; the wallet has ${sol(have)}`}. Nothing was sent.`);
}

/**
 * Kivo's own fee wallet (also the sponsor) trading for itself: the same
 * transaction, paid from its own SOL, after the same intent and spend checks.
 */
async function signAndSendOwnFeeSolanaStep(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  lookupTables: InstanceType<typeof import('@solana/web3.js').AddressLookupTableAccount>[],
  signer: SolanaTransactionSigner,
  connection: InstanceType<typeof import('@solana/web3.js').Connection>,
  simulationConnection: InstanceType<typeof import('@solana/web3.js').Connection>,
  tokenAccountReadConnection: InstanceType<typeof import('@solana/web3.js').Connection>,
  spendIntent?: SolanaSpendIntent,
): Promise<{signature: string; warnings: string[]}> {
  const [{TransactionMessage, VersionedTransaction}, bs58Module] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  const {blockhash} = await connection.getLatestBlockhash('confirmed');
  const unsigned = new VersionedTransaction(new TransactionMessage({payerKey: signer.publicKey, instructions, recentBlockhash: blockhash}).compileToV0Message(lookupTables));
  const warnings = assertSolanaTransactionMatchesIntent(unsigned, {expectedSigner: signer.publicKey.toBase58(), addressLookupTableAccounts: lookupTables});
  if (spendIntent) {
    try {
      await assertSolanaSpendWithinIntentWeb3(simulationConnection, unsigned, signer.publicKey.toBase58(), spendIntent, tokenAccountReadConnection);
    } catch (guardErr) {
      if (!isInsufficientSolSimulation(guardErr)) throw guardErr;
      throw (await feeWalletShortfallError(connection, signer.publicKey, instructions, guardErr instanceof Error ? `${guardErr.message} ${(guardErr as {logs?: string[]}).logs?.join(' ') ?? ''}` : String(guardErr))) ?? guardErr;
    }
  }
  const transaction = await signer.sign(unsigned);
  const signature = bs58Module.default.encode(transaction.signatures[0]);
  await connection.sendRawTransaction(transaction.serialize());
  return {signature: await confirmSolanaSignature(connection, signature), warnings};
}

export async function signAndSendSponsoredSolanaStep(
  instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[],
  lookupTables: InstanceType<typeof import('@solana/web3.js').AddressLookupTableAccount>[],
  signer: SolanaTransactionSigner,
  connection: InstanceType<typeof import('@solana/web3.js').Connection>,
  spendIntent?: SolanaSpendIntent,
  options: {allowedAtaOwners?: string[]} = {},
): Promise<{signature: string; warnings: string[]}> {
  const [{Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram}, bs58Module, splToken] = await Promise.all([
    import('@solana/web3.js'),
    import('bs58'),
    import('@solana/spl-token'),
  ]);
  const bs58 = bs58Module.default;
  const tokenAccountReadConnection = new Connection(SOLANA_TOKEN_ACCOUNT_READ_RPC_URL, 'confirmed');
  const simulationConnection = new Connection(SOLANA_SIMULATION_RPC_URL, 'confirmed');
  const feePayerPubkey = new PublicKey(await getSolanaFeePayerPublicKey());
  // Kivo's own fee wallet can't sponsor itself: it pays its own Solana fees.
  if (signer.publicKey.equals(feePayerPubkey)) {
    return signAndSendOwnFeeSolanaStep(instructions, lookupTables, signer, connection, simulationConnection, tokenAccountReadConnection, spendIntent);
  }
  // AccountNotFound at this stage is a fee-payer validation failure on
  // Solana. Read the sponsor balance from the standard RPC before asking
  // it to simulate the full trade, so a genuinely unfunded sponsor gets
  // a precise error instead of being misreported as a route failure.
  const sponsorBalance = await simulationConnection.getBalance(feePayerPubkey, 'confirmed');
  if (sponsorBalance <= 0) {
    throw new Error('Kivo fee sponsorship is temporarily unavailable because its Solana fee-payer wallet has no SOL. The sponsor needs a SOL top-up; the trade itself was not signed or sent.');
  }
  const user = signer.publicKey;
  type Ix = InstanceType<typeof TransactionInstruction>;
  const {blockhash} = await connection.getLatestBlockhash('confirmed');
  const simulate = (ixs: Ix[], addresses: string[] = []) => simulationConnection.simulateTransaction(
    new VersionedTransaction(new TransactionMessage({payerKey: feePayerPubkey, instructions: ixs, recentBlockhash: blockhash}).compileToV0Message(lookupTables)),
    {sigVerify: false, replaceRecentBlockhash: true, ...(addresses.length ? {accounts: {encoding: 'base64' as const, addresses}} : {})},
  );

  // 1. Token accounts that already exist keep the user as their (no-op)
  // payer. A failed lookup assumes none exist: the sponsor then funds them
  // and is repaid, never the other way around.
  const existingAccounts = new Set<string>();
  const ataTargets = associatedTokenAccountTargets(instructions);
  if (ataTargets.length) {
    try {
      const infos = await connection.getMultipleAccountsInfo(ataTargets.map(address => new PublicKey(address)), 'confirmed');
      infos.forEach((info, i) => { if (info) existingAccounts.add(ataTargets[i]); });
    } catch (err) {
      void recordDiagnosticEvent('sponsorship.ata-lookup-failed', err);
    }
  }
  const rewrittenInstructions = rewriteAccountCreationFundingInstructions(instructions, feePayerPubkey, TransactionInstruction, {skipAccounts: existingAccounts});

  // 2. A new WSOL account the sponsor funds and the route only uses in
  // passing (USDC -> SOL -> token) is closed back to the sponsor: the route's
  // own close (to the user) is redirected, or one is added. Only when a
  // simulation without those closes shows the account holds exactly its rent
  // and no WSOL, so the sponsor gets its rent back and nothing of the user's.
  // Otherwise (e.g. a sell to SOL, where the close unwraps the proceeds) the
  // route's close stays the user's and the rent is repaid in step 3.
  const closedBackAtas = new Set<string>();
  let baseInstructions = rewrittenInstructions;
  const wsolAccounts = sponsorFundedWsolAccounts(rewrittenInstructions, feePayerPubkey, user);
  if (wsolAccounts.length) {
    try {
      const closesWsol = (ix: Ix) => isTokenCloseAccount(ix) && wsolAccounts.includes(ix.keys[0].pubkey.toBase58());
      const probe = await simulate(rewrittenInstructions.filter(ix => !closesWsol(ix)), wsolAccounts);
      const rent = rentExemptLamports(CLASSIC_TOKEN_ACCOUNT_SPACE);
      const closable = new Set(wsolAccounts.filter((_, i) => {
        const account = probe.value.err ? null : probe.value.accounts?.[i];
        if (!account || account.lamports !== rent) return false;
        const data = Array.isArray(account.data) ? Buffer.from(account.data[0], 'base64') : null;
        return data !== null && tokenAccountAmount(data) === 0n;
      }));
      if (closable.size) {
        const redirected = rewrittenInstructions.map(ix => (
          isTokenCloseAccount(ix) && closable.has(ix.keys[0].pubkey.toBase58()) && ix.keys[1].pubkey.equals(user) && ix.keys[2].pubkey.equals(user)
            ? withCloseDestination(ix, feePayerPubkey, TransactionInstruction) : ix));
        const routeClosed = new Set(redirected.filter(ix => isTokenCloseAccount(ix) && ix.keys[1].pubkey.equals(feePayerPubkey)).map(ix => ix.keys[0].pubkey.toBase58()));
        // Accounts the route doesn't close itself get a close at the end. Never
        // touch one the route closes somewhere else.
        const routeClosesElsewhere = new Set(redirected.filter(ix => isTokenCloseAccount(ix) && !ix.keys[1].pubkey.equals(feePayerPubkey)).map(ix => ix.keys[0].pubkey.toBase58()));
        const added = [...closable].filter(a => !routeClosed.has(a) && !routeClosesElsewhere.has(a))
          .map(a => splToken.createCloseAccountInstruction(new PublicKey(a), feePayerPubkey, user));
        const candidate = [...redirected, ...added];
        const check = await simulate(candidate);
        if (!check.value.err) {
          baseInstructions = candidate;
          for (const a of closable) if (!routeClosesElsewhere.has(a)) closedBackAtas.add(a);
        }
      }
    } catch (err) {
      closedBackAtas.clear();
      void recordDiagnosticEvent('sponsorshipRecovery.wsol-close-skipped', err);
    }
  }
  // A pool program (e.g. PumpSwap's one-time per-user account) can charge the
  // wallet itself, which a sponsored wallet with no SOL can't pay. Kivo tops
  // the wallet up by exactly the shortfall the simulation reports; Kivo's
  // server co-signs only if the trade spends all of it (the user never keeps
  // it) and it is repaid below like rent. While topped up, the server allows
  // no token account the wallet pays for itself, so no-op creates of existing
  // accounts are dropped.
  let topUpLamports = 0;
  try {
    const simulation = await simulate(baseInstructions);
    const short = simulation.value.err ? (simulation.value.logs ?? []).map(line => /insufficient lamports (\d+), need (\d+)/.exec(line)).find(match => match !== null) : null;
    const needed = short ? Number(short[2]) - Number(short[1]) : 0;
    if (needed > 0 && needed <= MAX_SPONSOR_TOPUP_LAMPORTS) {
      const withoutUserPaidCreates = baseInstructions.filter(ix => !(ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID && !ix.keys[0]?.pubkey.equals(feePayerPubkey) && existingAccounts.has(ix.keys[1]?.pubkey.toBase58() ?? '')));
      const withTopUp = [SystemProgram.transfer({fromPubkey: feePayerPubkey, toPubkey: user, lamports: needed}), ...withoutUserPaidCreates];
      const check = await simulate(withTopUp);
      if (!check.value.err) { baseInstructions = withTopUp; topUpLamports = needed; }
    }
  } catch (err) {
    void recordDiagnosticEvent('sponsorship.topup-skipped', err);
  }

  // 3. Repay the sponsor-funded rent (and top-up) in this same transaction.
  // Token-2022 accounts' size depends on their mint: measure it.
  const measured = new Map<string, number>();
  const token2022Accounts = sponsorFundedToken2022Accounts(baseInstructions, feePayerPubkey);
  if (token2022Accounts.length) {
    try {
      const simulation = await simulate(baseInstructions, token2022Accounts);
      token2022Accounts.forEach((address, i) => {
        const lamports = simulation.value.accounts?.[i]?.lamports;
        if (typeof lamports === 'number') measured.set(address, lamports);
      });
    } catch (err) {
      void recordDiagnosticEvent('sponsorship.token2022-measure-failed', err);
    }
  }
  const funded = sponsorFundedRent(baseInstructions, feePayerPubkey, {closedBack: closedBackAtas, measured});
  if (funded.creations > MAX_SPONSOR_FUNDED_CREATIONS) {
    throw new Error(`This route needs ${funded.creations} new token accounts; Kivo sponsors at most ${MAX_SPONSOR_FUNDED_CREATIONS} per transaction. Add a little SOL to this wallet (about 0.01) or try a smaller route. Nothing was sent.`);
  }
  const repaymentLamports = funded.lamports + topUpLamports;
  let finalInstructions = baseInstructions;
  // USDC / SOL this transaction repays the sponsor with, on top of the trade:
  // allowed by the spend guard below as Kivo's, not the route's.
  let recoveryUnitsIncluded = 0n;
  let recoveryLamportsIncluded = 0n;
  const withMeasuredComputeLimit = async (candidate: Ix[]): Promise<Ix[] | null> => {
    const simulation = await simulate(candidate);
    if (simulation.value.err) return null;
    if (typeof simulation.value.unitsConsumed !== 'number') return candidate;
    const safeUnits = Math.ceil(simulation.value.unitsConsumed * COMPUTE_BUDGET_SAFETY_MULTIPLE);
    return withComputeUnitLimit(candidate, safeUnits, ComputeBudgetProgram.setComputeUnitLimit({units: safeUnits}));
  };
  if (repaymentLamports > 0) {
    // Preferred: USDC, the wallet's normal balance. On a sell to USDC the swap
    // earlier in this transaction pays the user, so the simulation decides.
    try {
      const usdcMintAddress = TOKEN_ADDRESSES.USDC?.solana;
      const units = usdcMintAddress ? await sponsorRepaymentUsdcUnits(repaymentLamports) : 0n;
      if (usdcMintAddress && units > 0n) {
        const usdcMint = new PublicKey(usdcMintAddress);
        const userUsdcAta = await splToken.getAssociatedTokenAddress(usdcMint, user);
        const sponsorUsdcAta = await splToken.getAssociatedTokenAddress(usdcMint, feePayerPubkey);
        // Never create the sponsor's own USDC account inside a user's
        // transaction (the server refuses the sponsor as an ATA owner).
        if (await connection.getAccountInfo(sponsorUsdcAta, 'confirmed')) {
          const candidate = await withMeasuredComputeLimit([...baseInstructions, splToken.createTransferInstruction(userUsdcAta, sponsorUsdcAta, user, units)]);
          if (candidate) { finalInstructions = candidate; recoveryUnitsIncluded = units; }
        }
      }
    } catch (err) {
      void recordDiagnosticEvent('sponsorshipRecovery.usdc-skipped', err);
    }
    // Otherwise SOL, e.g. the proceeds of a sell to SOL in this same transaction.
    if (recoveryUnitsIncluded === 0n) {
      try {
        const candidate = await withMeasuredComputeLimit([...baseInstructions, SystemProgram.transfer({fromPubkey: user, toPubkey: feePayerPubkey, lamports: repaymentLamports})]);
        if (candidate) { finalInstructions = candidate; recoveryLamportsIncluded = BigInt(repaymentLamports); }
      } catch (err) {
        void recordDiagnosticEvent('sponsorshipRecovery.sol-skipped', err);
      }
    }
    if (recoveryUnitsIncluded === 0n && recoveryLamportsIncluded === 0n) {
      const what = [funded.accounts.length ? `${funded.accounts.length} new token account${funded.accounts.length === 1 ? '' : 's'}` : '', topUpLamports ? 'a SOL top-up' : ''].filter(Boolean).join(' and ');
      throw new Error(`This needs a one-time ${(repaymentLamports / 1e9).toFixed(6)} SOL deposit for ${what}, which Kivo fronts and your wallet repays in the same transaction (in USDC or SOL). This wallet can't cover it right now; add a little USDC or SOL and try again. Nothing was sent.`);
    }
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
    allowedAtaOwners: options.allowedAtaOwners,
    sponsorClosableAccounts: [...closedBackAtas],
  });
  // The semantic check (solanaSpendGuard.ts): the wallet's balances may
  // only change as the trade allows. Sponsorship moves who pays the fee,
  // not what the user may lose.
  if (spendIntent) {
    const usdcMintAddress = TOKEN_ADDRESSES.USDC?.solana;
    const extra = recoveryUnitsIncluded > 0n && usdcMintAddress ? [...(spendIntent.extra ?? []), {mint: usdcMintAddress, units: recoveryUnitsIncluded}]
      : recoveryLamportsIncluded > 0n ? [...(spendIntent.extra ?? []), {mint: SOLANA_NATIVE_SPEND, units: recoveryLamportsIncluded}]
      : spendIntent.extra;
    await assertSolanaSpendWithinIntentWeb3(simulationConnection, unsignedTransaction, signer.publicKey.toBase58(), {...spendIntent, extra}, tokenAccountReadConnection);
  }

  const transaction = await signer.sign(unsignedTransaction);

  if (!SOLANA_SPONSOR_FEE_URL) throw new Error('Kivo Solana fee sponsorship is not configured.');
  // The sponsor endpoint only adds the fee-payer signature; it never broadcasts.
  // Retrying the exact same user-signed message on transient 5xx/network failures
  // cannot submit a duplicate swap. Never fall back to user-paid SOL.
  const serializedUserSignedTransaction = Buffer.from(transaction.serialize()).toString('base64');
  let res: Response | null = null;
  let responseText = '';
  let lastSponsorError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(SOLANA_SPONSOR_FEE_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({transaction: serializedUserSignedTransaction}),
      });
      responseText = await res.text();
      if (res.ok || res.status < 500 || attempt === 2) break;
      lastSponsorError = `HTTP ${res.status}`;
    } catch (error) {
      lastSponsorError = error instanceof Error ? error.message : 'network error';
      if (attempt === 2) break;
    }
    await new Promise<void>(resolve => setTimeout(resolve, attempt === 0 ? 250 : 700));
  }
  if (!res) {
    throw new Error(`Kivo's Solana fee sponsor is temporarily unreachable (${lastSponsorError || 'network error'}). No transaction was broadcast. Please try again shortly.`);
  }
  let responseBody: {error?: string; data?: {transaction?: string}};
  try {
    responseBody = JSON.parse(responseText) as {error?: string; data?: {transaction?: string}};
  } catch {
    responseBody = {};
  }
  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error(`Kivo's Solana fee sponsor is temporarily unavailable (HTTP ${res.status}). No transaction was broadcast. Please try again shortly.`);
    }
    const serverReason = typeof responseBody.error === 'string' ? responseBody.error : '';
    const reason = serverReason || responseText.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`Kivo fee sponsorship was refused (HTTP ${res.status})${reason ? `: ${reason}` : ''}. No transaction was broadcast.`);
  }
  const sponsoredTransactionBase64 = responseBody.data?.transaction;
  if (typeof sponsoredTransactionBase64 !== 'string' || sponsoredTransactionBase64.length === 0) {
    throw new Error('Fee sponsorship endpoint returned no sponsored transaction.');
  }

  const signedTransaction = VersionedTransaction.deserialize(Buffer.from(sponsoredTransactionBase64, 'base64'));
  const signature = bs58.encode(signedTransaction.signatures[0]);
  try {
    await connection.sendRawTransaction(signedTransaction.serialize());
  } catch (sendError) {
    // Only a preflight rejection proves the signed transaction never reached the network.
    throw solanaSubmitDefinitelyRejected(sendError) ? sendError : markMaybeBroadcast(sendError, {signature});
  }
  return {signature: await confirmSolanaSignature(connection, signature), warnings};
}

/**
 * Kivo's withdrawal fee as a USDC transfer from `user` to the Solana sponsor's
 * USDC account, appended to a withdrawal's own transaction. Kivo's sponsor
 * treats a transaction carrying it as paying its own way (never quota-limited).
 */
export async function kivoWithdrawalFeeInstruction(user: InstanceType<typeof import('@solana/web3.js').PublicKey>, units: bigint): Promise<InstanceType<typeof import('@solana/web3.js').TransactionInstruction>> {
  const [{Connection, PublicKey}, splToken] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
  const usdcMintAddress = TOKEN_ADDRESSES.USDC?.solana;
  if (!usdcMintAddress) throw new Error('No verified USDC mint for Solana.');
  const mint = new PublicKey(usdcMintAddress);
  const sponsorUsdcAta = await splToken.getAssociatedTokenAddress(mint, new PublicKey(await getSolanaFeePayerPublicKey()));
  if (!await new Connection(SOLANA_RPC_URL, 'confirmed').getAccountInfo(sponsorUsdcAta, 'confirmed')) throw new Error("Kivo's withdrawal fee account isn't ready. Nothing was sent; try again later.");
  return splToken.createTransferInstruction(await splToken.getAssociatedTokenAddress(mint, user), sponsorUsdcAta, user, units);
}

export async function signAndSendRelaySolanaStep(item: RelayTransactionStepItem, secretKeyBase58: string, spendIntent: SolanaSpendIntent, stepOptions: {withdrawalFeeUnits?: bigint} = {}): Promise<{signature: string; warnings: string[]}> {
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
  if (stepOptions.withdrawalFeeUnits) instructions.push(await kivoWithdrawalFeeInstruction(keypair.publicKey, stepOptions.withdrawalFeeUnits));
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
    const feeWalletError = await feeWalletShortfallError(connection, keypair.publicKey, instructions, guardErr instanceof Error ? `${guardErr.message} ${(guardErr as {logs?: string[]}).logs?.join(' ') ?? ''}` : String(guardErr));
    if (feeWalletError) throw feeWalletError;
    try {
      return await signAndSendSponsoredSolanaStep(instructions, lookupTables, localSigner, connection, spendIntent);
    } catch (sponsorErr) {
      // The preflight already established why sponsorship was attempted.
      // Preserve the sponsor's actual failure (HTTP 502, sponsor balance,
      // policy rejection, or simulation failure) instead of mislabeling
      // every sponsorship error as the user's SOL balance problem.
      throw sponsorErr instanceof Error ? sponsorErr : new Error(String(sponsorErr));
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
      const feeWalletError = await feeWalletShortfallError(connection, keypair.publicKey, instructions, errorMessage);
      if (feeWalletError) throw feeWalletError;
      // Nothing was broadcast yet (this is our own pre-flight simulate
      // rejecting it) — safe to retry with Kivo's fee payer covering
      // the shortfall instead of failing outright. Only falls through
      // to the plain "add more SOL" message if sponsorship itself isn't
      // available or also fails.
      try {
        return await signAndSendSponsoredSolanaStep(instructions, lookupTables, localSigner, connection, spendIntent);
      } catch (sponsorErr) {
        // Preserve the sponsor's real error. A 5xx or a rejected
        // simulation is not evidence that the user's SOL balance is wrong.
        throw sponsorErr instanceof Error ? sponsorErr : new Error(String(sponsorErr));
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
async function signAndSendRelaySolanaStepViaParticle(item: RelayTransactionStepItem, solanaAddress: string, spendIntent: SolanaSpendIntent, stepOptions: {withdrawalFeeUnits?: bigint} = {}): Promise<{signature: string; warnings: string[]}> {
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
  if (stepOptions.withdrawalFeeUnits) instructions.push(await kivoWithdrawalFeeInstruction(payerKey, stepOptions.withdrawalFeeUnits));
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
    // Accounts that already exist cost nothing; if the lookup fails, all are new (worst case).
    const targets = associatedTokenAccountTargets(instructions);
    const existing = new Set<string>();
    if (targets.length) {
      const infos = await connection.getMultipleAccountsInfo(targets.map(address => new PublicKey(address)), 'confirmed').catch(() => null);
      infos?.forEach((info, i) => { if (info) existing.add(targets[i]); });
    }
    const requiredLamports = estimateSponsorshipLamportsCost(instructions, message.header.numRequiredSignatures, existing);
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
        // Preserve the sponsor's real error instead of blaming the
        // user's SOL balance for an endpoint or simulation failure.
        throw sponsorErr instanceof Error ? sponsorErr : new Error(String(sponsorErr));
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
    // A failed status read is not a failed transaction: keep polling until the deadline.
    const {value} = await connection.getSignatureStatuses([signature]).catch(() => ({value: [null]}));
    const status = value?.[0];
    if (status) {
      if (status.err) {
        const error = new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
        (error as {signature?: string}).signature = signature;
        throw error;
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return {signature, warnings: solanaWarnings};
    }
    if (Date.now() >= deadline) throw markMaybeBroadcast(new Error(`Transaction ${signature} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature});
    await new Promise<void>(r => setTimeout(r, 1200));
  }
}

export type ExecuteRelayQuoteResult = {txHashes: string[]; warnings: string[]; status?: RelaySettlement; requestId?: string | null};

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
    /**
     * A withdrawal from the Solana home balance: Kivo's withdrawal fee (USDC
     * base units), paid to the Solana sponsor in the route's first Solana
     * transaction, on top of the quoted amount.
     */
    solanaWithdrawalFeeUnits?: bigint;
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
  void recordDiagnosticEvent(
    'executeRelayQuote.pending-items',
    new Error(`Relay quote has ${pendingItems.length} pending transaction item(s) across chain ids ${[...new Set(pendingItems.map(item => String(item.data?.chainId ?? 'unknown')))].join(', ')}.`),
  );

  const warnings = assertQuoteSafeToSign(quote, tagged.intent, pendingItems);
  for (const warning of warnings) {
    void recordDiagnosticEvent('txIntentFirewall.warning', warning);
  }

  onStep?.('signing');
  const isGoogleSession = session.authMethod === 'google';
  const txHashes: string[] = [];
  // Set when Relay accepted a gasless batch but has not confirmed it yet.
  let gaslessPendingRequestId: string | null = null;
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

    // Only the route's last Solana step delivers the bought token; earlier
    // steps (account setup, wrapping) are checked for spend limits only.
    const lastSolanaUnit = [...units].reverse().find(u => u.kind === 'solana');
    const firstSolanaUnit = units.find(u => u.kind === 'solana');
    for (const unit of units) {
      if (unit.kind === 'solana') {
        const item = unit.item;
        const baseIntent = solanaSpendIntentFor(tagged.intent);
        const withdrawalFeeUnits = unit === firstSolanaUnit && options?.solanaWithdrawalFeeUnits ? options.solanaWithdrawalFeeUnits : undefined;
        const usdcMint = TOKEN_ADDRESSES.USDC?.solana;
        const spendIntent = {
          ...baseIntent,
          // Kivo's withdrawal fee is allowed on top of the route's own spend.
          ...(withdrawalFeeUnits && usdcMint ? {extra: [...(baseIntent.extra ?? []), {mint: usdcMint, units: withdrawalFeeUnits}]} : {}),
          ...(unit === lastSolanaUnit ? await solanaOutputVerificationFor(quote, tagged.intent, session.solana.address) : {}),
        };
        const {signature, warnings: solanaStepWarnings} = isGoogleSession
          ? await signAndSendRelaySolanaStepViaParticle(item, session.solana.address, spendIntent, {withdrawalFeeUnits})
          : await signAndSendRelaySolanaStep(item, session.solana.privateKey, spendIntent, {withdrawalFeeUnits});
        txHashes.push(signature);
        for (const warning of solanaStepWarnings) {
          void recordDiagnosticEvent('solanaTxIntent.warning', warning);
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

      try {
        const relayResult = await sendEvmCallsViaRelayGasless({
          chain: viemChain,
          fromAddress: owner.address,
          account: owner,
          calls,
          requestId,
        });
        txHashes.push(relayResult.hash);
      } catch (err) {
        // Accepted by Relay but not confirmed yet: stop here (later steps
        // depend on it) and report the trade as still settling.
        if (err instanceof RelayGaslessPendingError) {
          gaslessPendingRequestId = err.requestId;
          break;
        }
        throw err;
      }
    }
  } catch (err) {
    // A Solana output-minimum failure is detected by simulation before the
    // first signature is made. The pool/route may have moved between quote
    // and simulation, so request one fresh quote and retry once while no
    // transaction has been broadcast. Never requote after a partial route
    // has landed, and never loop: the retry deliberately receives no
    // requote callback. Keep the spend guard intact on both attempts.
    if (
      txHashes.length === 0 &&
      options?.requote &&
      err instanceof SolanaSpendGuardError &&
      /did not deliver the expected output token/i.test(err.message)
    ) {
      const refreshedQuote = await options.requote();
      return executeRelayQuote(refreshedQuote, session, onStep, {solanaWithdrawalFeeUnits: options.solanaWithdrawalFeeUnits});
    }
    attachPartialTxHashes(err, txHashes);
    throw err;
  }
  if (gaslessPendingRequestId) {
    onStep?.('done');
    return {txHashes, warnings, status: 'pending', requestId: requestId ?? gaslessPendingRequestId};
  }

  let status: RelaySettlement = 'success';
  if (requestId) {
    onStep?.('filling');
    try {
      status = await pollRelayStatus(requestId);
    } catch (err) {
      attachPartialTxHashes(err, txHashes);
      throw err;
    }
  }
  onStep?.('done');
  return {txHashes, warnings, status, requestId: requestId ?? null};
}
