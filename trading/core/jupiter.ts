// Solana trades straight on Jupiter, with Kivo's Solana fee payer covering
// network fees and new token-account rent (signAndSendSponsoredSolanaStep:
// spend guard, simulation, Kivo co-signature, broadcast).
//
// Jupiter's keyless API is tried first; Kivo's /api/jupiter proxy (which can
// hold a Jupiter API key) is the fallback.

import {SOLANA_RPC_URL, getSolanaFeePayerPublicKey, signAndSendSponsoredSolanaStep, type SolanaTransactionSigner} from './executeRelayQuote.ts';
import {recordDiagnosticEvent} from '../../src/debug/diagnosticLog';
import {applyJupiterFeeToSpendIntent, type SolanaSpendIntent} from './solanaSpendGuard.ts';

const JUPITER_DIRECT = 'https://lite-api.jup.ag/swap/v1';
const JUPITER_PROXY = 'https://kivotrade.site/api/jupiter';

export type JupiterQuote = {inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct?: string; [key: string]: unknown};

async function jupiter(path: string, init?: RequestInit, validateBody?: (body: unknown) => void): Promise<unknown> {
  let lastError: unknown = null;
  for (const base of [JUPITER_DIRECT, JUPITER_PROXY]) {
    try {
      const res = await fetch(`${base}${path}`, init);
      const body = await res.json().catch(() => null) as {error?: string; errorCode?: string} | null;
      if (res.ok && body && !body.error) {
        try {
          validateBody?.(body);
          return body;
        } catch (error) {
          // A successful HTTP response can still contain malformed instruction
          // addresses. Try the alternate Jupiter endpoint before refusing to sign.
          lastError = error;
          continue;
        }
      }
      lastError = new Error(body?.error || `Jupiter returned ${res.status}.`);
      if (res.status === 400) break; // a real "no route" / bad request: the proxy would say the same
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Jupiter is not reachable right now.');
}

/** Exact-input quote, or null when Jupiter has no route. */
export async function quoteJupiter(params: {inputMint: string; outputMint: string; amount: bigint; slippageBps: number}): Promise<JupiterQuote | null> {
  const query = new URLSearchParams({inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount.toString(), slippageBps: String(params.slippageBps), restrictIntermediateTokens: 'true'});
  try {
    const quote = await jupiter(`/quote?${query}`) as JupiterQuote;
    return quote && /^\d+$/.test(String(quote.outAmount)) && BigInt(quote.outAmount) > 0n ? quote : null;
  } catch {
    return null;
  }
}

type JupiterInstruction = {programId: string; accounts: {pubkey: string; isSigner: boolean; isWritable: boolean}[]; data: string};
type SwapInstructions = {
  computeBudgetInstructions?: JupiterInstruction[]; setupInstructions?: JupiterInstruction[]; swapInstruction: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null; otherInstructions?: JupiterInstruction[]; addressLookupTableAddresses?: string[];
};

/**
 * Builds and sends one Jupiter swap. `fee` is Kivo's fee in USDC: paid from
 * the user's USDC before the swap (buys) or after it (sells), to Kivo's
 * Solana fee wallet's USDC account (created by the fee payer if missing).
 */
export async function executeJupiterSwap(params: {
  quote: JupiterQuote; secretKeyBase58: string; expectedSolanaAddress: string; spendIntent: SolanaSpendIntent;
  fee: {usdcMint: string; units: bigint; when: 'before' | 'after'; wallet: string};
}): Promise<{signature: string}> {
  const [{Connection, Keypair, PublicKey, TransactionInstruction}, bs58Module, splToken] = await Promise.all([import('@solana/web3.js'), import('bs58'), import('@solana/spl-token')]);
  let keypair: InstanceType<typeof Keypair>;
  try {
    keypair = Keypair.fromSecretKey(bs58Module.default.decode(params.secretKeyBase58));
  } catch {
    throw new Error('The active Solana signing key is invalid. Refusing to build a swap.');
  }
  const user = keypair.publicKey;
  const parsePublicKey = (value: unknown, label: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid Solana address for ${label}: value is missing.`);
    try {
      return new PublicKey(value);
    } catch {
      throw new Error(`Invalid Solana address for ${label}. Check the token mint, fee configuration, or Jupiter response.`);
    }
  };
  if (typeof params.expectedSolanaAddress !== 'string' || !params.expectedSolanaAddress.trim()) {
    throw new Error('The active session has no Solana public address. Refusing to sign a swap.');
  }
  const expectedUser = parsePublicKey(params.expectedSolanaAddress, 'active session wallet');
  if (!user.equals(expectedUser)) {
    throw new Error('The Solana signing key does not match the active session wallet. Refusing to sign.');
  }
  const validateAddress = (value: unknown, label: string) => { parsePublicKey(value, label); };
  const validateInstruction = (value: unknown, label: string) => {
    if (!value || typeof value !== 'object') throw new Error(`Jupiter returned a missing ${label} instruction.`);
    const instruction = value as Partial<JupiterInstruction>;
    validateAddress(instruction.programId, `${label} program`);
    if (!Array.isArray(instruction.accounts)) throw new Error(`Jupiter returned malformed account keys for ${label}.`);
    instruction.accounts.forEach((account, index) => {
      validateAddress(account?.pubkey, `${label} account ${index + 1}`);
      if (typeof account?.isSigner !== 'boolean' || typeof account?.isWritable !== 'boolean') {
        throw new Error(`Jupiter returned malformed signer/writable flags for ${label} account ${index + 1}.`);
      }
    });
    if (typeof instruction.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(instruction.data)) {
      throw new Error(`Jupiter returned malformed base64 instruction data for ${label}.`);
    }
  };
  const swap = await jupiter('/swap-instructions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      quoteResponse: params.quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {priorityLevelWithMaxLamports: {maxLamports: 200_000, priorityLevel: 'medium'}},
    }),
  }, body => {
    if (!body || typeof body !== 'object') throw new Error('Jupiter returned a malformed swap-instructions response.');
    const instructions = body as Partial<SwapInstructions>;
    validateInstruction(instructions.swapInstruction, 'swap');
    for (const [label, list] of [
      ['compute-budget', instructions.computeBudgetInstructions],
      ['setup', instructions.setupInstructions],
      ['other', instructions.otherInstructions],
    ] as const) {
      if (list != null && !Array.isArray(list)) throw new Error(`Jupiter returned malformed ${label} instructions.`);
      (list ?? []).forEach((instruction, index) => validateInstruction(instruction, `${label} ${index + 1}`));
    }
    if (instructions.cleanupInstruction != null) validateInstruction(instructions.cleanupInstruction, 'cleanup');
    if (instructions.addressLookupTableAddresses != null) {
      if (!Array.isArray(instructions.addressLookupTableAddresses)) throw new Error('Jupiter returned malformed address lookup tables.');
      instructions.addressLookupTableAddresses.forEach((address, index) => validateAddress(address, `address lookup table ${index + 1}`));
    }
  }) as SwapInstructions;
  const toIx = (ix: JupiterInstruction) => new TransactionInstruction({
    programId: parsePublicKey(ix.programId, 'Jupiter instruction program'),
    keys: ix.accounts.map(a => ({pubkey: parsePublicKey(a.pubkey, 'Jupiter instruction account'), isSigner: a.isSigner, isWritable: a.isWritable})),
    data: Buffer.from(ix.data, 'base64'),
  });

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const feeIxs: InstanceType<typeof TransactionInstruction>[] = [];
  // Actual post-swap USDC fee included in the transaction (zero when skipped).
  let feeUnitsIncluded = 0n;
  if (params.fee.units > 0n) {
    const mint = parsePublicKey(params.fee.usdcMint, 'Kivo USDC fee mint');
    const wallet = parsePublicKey(params.fee.wallet, 'Kivo Solana fee wallet');
    const from = await splToken.getAssociatedTokenAddress(mint, user);
    const to = await splToken.getAssociatedTokenAddress(mint, wallet);
    const feePayer = parsePublicKey(await getSolanaFeePayerPublicKey(), 'Kivo Solana fee payer');
    const sponsorOwnsFeeAta = wallet.equals(feePayer);
    if (sponsorOwnsFeeAta) {
      // The sponsor cannot create its own ATA inside a user-sponsored
      // transaction: the ATA instruction would name it as both payer and
      // owner, which the backend deliberately rejects. If the ATA already
      // exists, a plain user-authorized USDC transfer is safe.
      const feeAtaInfo = await connection.getAccountInfo(to, 'confirmed');
      if (feeAtaInfo) {
        feeIxs.push(splToken.createTransferInstruction(from, to, user, params.fee.units));
        feeUnitsIncluded = params.fee.units;
      } else if (params.fee.when === 'after') {
        // Sell fees are optional to successful settlement. Never let a
        // missing treasury ATA block a sell; the user's output remains
        // protected by the original minimum, and no fee transfer is added.
        void recordDiagnosticEvent('jupiter.optional-sell-fee-skipped', new Error('Fee-payer USDC token account was not initialized.'));
      } else {
        // Do not silently change buy economics: the buy quote already
        // excludes the fee amount, so fail clearly until the treasury ATA
        // has been initialized outside the user's transaction.
        throw new Error('Kivo fee wallet USDC account is not initialized. Buy safely stopped; no transaction was sent.');
      }
    } else {
      // A distinct fee recipient may have its ATA created with Kivo's
      // sponsorship, since the sponsor is only the payer, not the owner.
      feeIxs.push(splToken.createAssociatedTokenAccountIdempotentInstruction(user, to, wallet, mint));
      feeIxs.push(splToken.createTransferInstruction(from, to, user, params.fee.units));
      feeUnitsIncluded = params.fee.units;
    }
  }

  const instructions = [
    ...(swap.computeBudgetInstructions ?? []).map(toIx),
    ...(params.fee.when === 'before' ? feeIxs : []),
    ...(swap.setupInstructions ?? []).map(toIx),
    toIx(swap.swapInstruction),
    ...(swap.cleanupInstruction ? [toIx(swap.cleanupInstruction)] : []),
    ...(swap.otherInstructions ?? []).map(toIx),
    ...(params.fee.when === 'after' ? feeIxs : []),
  ];

  const lookupTables = (await Promise.all((swap.addressLookupTableAddresses ?? []).map(address => connection.getAddressLookupTable(parsePublicKey(address, 'Jupiter address lookup table')).then(r => r.value))))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  // The spend guard must simulate the expected output token account even
  // when the wallet has never held that token (empty accounts are otherwise
  // omitted from its tracked-account list). Derive the ATA using the token
  // program that owns the mint, since Token-2022 ATAs differ from classic SPL.
  const spendIntent: SolanaSpendIntent = {...params.spendIntent};
  if (spendIntent.expectedOutputMint && spendIntent.expectedOutputMinimum && spendIntent.expectedOutputMinimum > 0n) {
    const outputMint = parsePublicKey(spendIntent.expectedOutputMint, 'expected output token mint');
    const mintAccount = await connection.getAccountInfo(outputMint, 'confirmed');
    if (!mintAccount) throw new Error('The expected output token mint could not be verified safely. Refusing to sign this trade.');
    const tokenProgram = mintAccount.owner.equals(splToken.TOKEN_PROGRAM_ID)
      ? splToken.TOKEN_PROGRAM_ID
      : mintAccount.owner.equals(splToken.TOKEN_2022_PROGRAM_ID)
        ? splToken.TOKEN_2022_PROGRAM_ID
        : null;
    if (!tokenProgram) throw new Error('The expected output token uses an unsupported token program. Refusing to sign this trade.');
    const outputAta = await splToken.getAssociatedTokenAddress(
      outputMint, user, false, tokenProgram, splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    spendIntent.expectedOutputAccounts = [...new Set([
      ...(spendIntent.expectedOutputAccounts ?? []),
      outputAta.toBase58(),
    ])];
  }

  const outputIsFeeMint = spendIntent.expectedOutputMint
    ? parsePublicKey(spendIntent.expectedOutputMint, 'expected output token mint').equals(parsePublicKey(params.fee.usdcMint, 'Kivo USDC fee mint'))
    : false;
  const finalSpendIntent = applyJupiterFeeToSpendIntent(
    spendIntent,
    params.fee.usdcMint,
    feeUnitsIncluded,
    params.fee.when === 'after',
    outputIsFeeMint,
  );

  const signer: SolanaTransactionSigner = {publicKey: user, sign: async tx => { tx.sign([keypair]); return tx; }};
  const {signature} = await signAndSendSponsoredSolanaStep(instructions, lookupTables, signer, connection, finalSpendIntent);
  return {signature};
}
