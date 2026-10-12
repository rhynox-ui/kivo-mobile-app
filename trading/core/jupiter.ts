// Solana trades straight on Jupiter, with Kivo's Solana fee payer covering
// network fees and new token-account rent (signAndSendSponsoredSolanaStep:
// spend guard, simulation, Kivo co-signature, broadcast).
//
// Jupiter's keyless API is tried first; Kivo's /api/jupiter proxy (which can
// hold a Jupiter API key) is the fallback.

import {SOLANA_RPC_URL, signAndSendSponsoredSolanaStep, type SolanaTransactionSigner} from './executeRelayQuote.ts';
import type {SolanaSpendIntent} from './solanaSpendGuard.ts';

const JUPITER_DIRECT = 'https://lite-api.jup.ag/swap/v1';
const JUPITER_PROXY = 'https://kivotrade.site/api/jupiter';

export type JupiterQuote = {inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct?: string; [key: string]: unknown};

async function jupiter(path: string, init?: RequestInit): Promise<unknown> {
  let lastError: unknown = null;
  for (const base of [JUPITER_DIRECT, JUPITER_PROXY]) {
    try {
      const res = await fetch(`${base}${path}`, init);
      const body = await res.json().catch(() => null) as {error?: string; errorCode?: string} | null;
      if (res.ok && body && !body.error) return body;
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
  quote: JupiterQuote; secretKeyBase58: string; spendIntent: SolanaSpendIntent;
  fee: {usdcMint: string; units: bigint; when: 'before' | 'after'; wallet: string};
}): Promise<{signature: string}> {
  const [{Connection, Keypair, PublicKey, TransactionInstruction}, bs58Module, splToken] = await Promise.all([import('@solana/web3.js'), import('bs58'), import('@solana/spl-token')]);
  const keypair = Keypair.fromSecretKey(bs58Module.default.decode(params.secretKeyBase58));
  const user = keypair.publicKey;
  const swap = await jupiter('/swap-instructions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      quoteResponse: params.quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {priorityLevelWithMaxLamports: {maxLamports: 200_000, priorityLevel: 'medium'}},
    }),
  }) as SwapInstructions;
  const toIx = (ix: JupiterInstruction) => new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable})),
    data: Buffer.from(ix.data, 'base64'),
  });

  const feeIxs: InstanceType<typeof TransactionInstruction>[] = [];
  if (params.fee.units > 0n) {
    const mint = new PublicKey(params.fee.usdcMint);
    const wallet = new PublicKey(params.fee.wallet);
    const from = await splToken.getAssociatedTokenAddress(mint, user);
    const to = await splToken.getAssociatedTokenAddress(mint, wallet);
    // Payer = user here; Kivo's fee payer takes over account funding when the transaction is built.
    feeIxs.push(splToken.createAssociatedTokenAccountIdempotentInstruction(user, to, wallet, mint));
    feeIxs.push(splToken.createTransferInstruction(from, to, user, params.fee.units));
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

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const lookupTables = (await Promise.all((swap.addressLookupTableAddresses ?? []).map(address => connection.getAddressLookupTable(new PublicKey(address)).then(r => r.value))))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  // The spend guard must simulate the expected output token account even
  // when the wallet has never held that token (empty accounts are otherwise
  // omitted from its tracked-account list). Derive the ATA using the token
  // program that owns the mint, since Token-2022 ATAs differ from classic SPL.
  const spendIntent: SolanaSpendIntent = {...params.spendIntent};
  if (spendIntent.expectedOutputMint && spendIntent.expectedOutputMinimum && spendIntent.expectedOutputMinimum > 0n) {
    const outputMint = new PublicKey(spendIntent.expectedOutputMint);
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

  const signer: SolanaTransactionSigner = {publicKey: user, sign: async tx => { tx.sign([keypair]); return tx; }};
  const {signature} = await signAndSendSponsoredSolanaStep(instructions, lookupTables, signer, connection, spendIntent);
  return {signature};
}
