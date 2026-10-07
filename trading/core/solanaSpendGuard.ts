// src/core/solanaSpendGuard.ts
//
// The semantic half of the Solana pre-sign check (solanaTxIntent.ts is
// the structural half). Found valid in an uploaded audit (C-03): the
// structural check proves the fee payer and the user's signature are
// right and that no top-level instruction hands out authority, but not
// that the transaction only spends what the user asked to spend. It
// can't: whatever program a route calls runs with the user's signature
// and can move any of the user's tokens internally (CPI), where no
// instruction-level decoder sees it.
//
// So this checks the one thing that is true for every honest trade,
// whatever program it goes through: simulate the exact transaction about
// to be signed and compare the wallet's own balances before and after.
//   - The token being spent may go down by at most the amount the user
//     entered (plus Mango's own sponsorship recovery, when included).
//   - Every other token account the wallet holds may not go down at all,
//     change owner, or gain a delegate.
//   - SOL may go down by at most the SOL being spent plus a small
//     allowance for network fees and new token-account rent.
// Anything else is refused before signing.
//
// Limits, stated plainly: token accounts beyond MAX_CHECKED_ACCOUNTS
// (only a wallet holding more than ~100 different non-empty tokens) are
// not checked; empty token accounts are not checked (there is nothing in
// them to take).

export const SOLANA_NATIVE_SPEND = 'SOL';
/** Network fees plus rent for a handful of new token accounts (~0.002 SOL each). */
export const SOLANA_OVERHEAD_LAMPORTS = 30_000_000n; // 0.03 SOL
/** simulateTransaction returns at most this many accounts in one call (the wallet itself + its token accounts). */
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export class SolanaSpendGuardError extends Error {
  /** True when the simulation itself failed, so nothing could be verified. */
  simulationFailed: boolean;
  logs: string[];
  constructor(message: string, {simulationFailed = false, logs = []}: {simulationFailed?: boolean; logs?: string[]} = {}) {
    super(message);
    this.name = 'SolanaSpendGuardError';
    this.simulationFailed = simulationFailed;
    this.logs = logs;
  }
}

export type SolanaSpendIntent = {
  /** SOLANA_NATIVE_SPEND, or the spent token's mint (compared case-insensitively — intents store addresses lowercased). */
  spend: string;
  /** Base units the user entered. */
  maxSpend: bigint;
  /** Further spends Mango itself adds (sponsorship cost recovery in USDC). */
  extra?: {mint: string; units: bigint}[];
  expectedOutputMint?: string;
  expectedOutputMinimum?: bigint;
  expectedOutputAccounts?: string[];
};

type Key = {toBase58(): string};
type ParsedTokenAccount = {pubkey: Key; account: {data: {parsed?: {info?: {mint?: string; tokenAmount?: {amount?: string}; delegate?: string}}}}};
type SimulatedAccount = {lamports: number; data: [string, string] | string[]} | null;
/** The parts of @solana/web3.js's Connection this needs — a structural type so tests can pass a stand-in. */
export type SpendGuardConnection = {
  getParsedTokenAccountsByOwner(owner: any, filter: {programId: any}): Promise<{value: ParsedTokenAccount[]}>;
  getBalance(owner: any): Promise<number>;
  simulateTransaction(tx: any, config: any): Promise<{value: {err: unknown; logs?: string[] | null; accounts?: SimulatedAccount[] | null}}>;
};

type Tracked = {address: string; mint: string; amount: bigint; delegate: string | null};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = v * 256n + BigInt(bytes[offset + i]);
  return v;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
}

/** An SPL token account's base layout (same for Token-2022): mint, owner, amount, delegate. */
function parseTokenAccount(data: Uint8Array, encode: (b: Uint8Array) => string): {mint: string; owner: string; amount: bigint; delegate: string | null} | null {
  if (data.length < 108) return null;
  return {
    mint: encode(data.subarray(0, 32)),
    owner: encode(data.subarray(32, 64)),
    amount: readU64LE(data, 64),
    delegate: readU32LE(data, 72) === 1 ? encode(data.subarray(76, 108)) : null,
  };
}

/**
 * Simulates `transaction` and refuses it (throws SolanaSpendGuardError)
 * unless the wallet's balances change only as `intent` allows. `owner`
 * and `programIds` are PublicKey instances (or anything the connection
 * accepts); `encodeBase58` turns 32 raw bytes into an address.
 */
export async function assertSolanaSpendWithinIntent(
  connection: SpendGuardConnection,
  transaction: unknown,
  {
    owner,
    ownerAddress,
    intent,
    tokenProgramIds,
    tokenAccountConnection,
    encodeBase58,
    overheadLamports = SOLANA_OVERHEAD_LAMPORTS,
    expectedOutputMint,
    expectedOutputMinimum = 0n,
    expectedOutputAccounts = [],
  }: {owner: unknown; ownerAddress: string; intent: SolanaSpendIntent; tokenProgramIds: [unknown, unknown]; tokenAccountConnection?: SpendGuardConnection; encodeBase58: (b: Uint8Array) => string; overheadLamports?: bigint; expectedOutputMint?: string; expectedOutputMinimum?: bigint; expectedOutputAccounts?: string[]},
): Promise<void> {
  const spendsSol = intent.spend === SOLANA_NATIVE_SPEND;
  const allowance = (mint: string): bigint =>
    (!spendsSol && eq(mint, intent.spend) ? intent.maxSpend : 0n) + (intent.extra ?? []).filter(e => eq(e.mint, mint)).reduce((s, e) => s + e.units, 0n);

  const tokenReader = tokenAccountConnection ?? connection;
  const [classic, t22, preLamports] = await Promise.all([
    tokenReader.getParsedTokenAccountsByOwner(owner, {programId: tokenProgramIds[0]}),
    tokenReader.getParsedTokenAccountsByOwner(owner, {programId: tokenProgramIds[1]}),
    connection.getBalance(owner),
  ]);
  const held: Tracked[] = [];
  for (const acc of [...classic.value, ...t22.value]) {
    const info = acc.account.data.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (!info?.mint || typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
    held.push({address: acc.pubkey.toBase58(), mint: info.mint, amount: BigInt(amount), delegate: info.delegate ?? null});
  }
  // Non-empty accounts only (an empty one has nothing to take); the
  // spent token's first, so a crowded wallet still has it checked.
  const tracked = held
    .filter(h => h.amount > 0n)
    .sort((a, b) => Number(allowance(b.mint) > 0n) - Number(allowance(a.mint) > 0n))
    .filter(h => h.amount > 0n);

  const sim = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: {encoding: 'base64', addresses: [ownerAddress, ...tracked.map(t => t.address), ...expectedOutputAccounts.filter(a => !tracked.some(t => eq(t.address, a)))]},
  });
  if (sim.value.err) {
    throw new SolanaSpendGuardError(`This transaction couldn't be verified before signing — it fails in simulation (${JSON.stringify(sim.value.err)}). Nothing was sent.`, {
      simulationFailed: true,
      logs: sim.value.logs ?? [],
    });
  }
  const post = sim.value.accounts;
  if (!Array.isArray(post) || post.length !== tracked.length + 1 + expectedOutputAccounts.filter(a => !tracked.some(t => eq(t.address, a))).length) {
    throw new SolanaSpendGuardError("This transaction couldn't be verified before signing (the simulation didn't return the wallet's balances). Nothing was sent.");
  }

  const spentByMint = new Map<string, bigint>();
  for (let i = 0; i < tracked.length; i++) {
    const before = tracked[i];
    const acc = post[i + 1];
    const raw = acc?.data?.[0];
    const parsed = typeof raw === 'string' ? parseTokenAccount(Uint8Array.from(Buffer.from(raw, 'base64')), encodeBase58) : null;
    // Closed, emptied into someone else's hands, or no longer this
    // wallet's: counts as all of it gone.
    const stillOurs = parsed && parsed.owner === ownerAddress && parsed.mint === before.mint;
    const after = stillOurs ? parsed.amount : 0n;
    if (stillOurs && parsed.delegate && parsed.delegate !== before.delegate) {
      throw new SolanaSpendGuardError('This transaction would give another account standing authority over one of your tokens. It was stopped before signing; nothing was sent.');
    }
    if (after < before.amount) {
      const key = before.mint.toLowerCase();
      spentByMint.set(key, (spentByMint.get(key) ?? 0n) + (before.amount - after));
    }
  }
  for (const [mint, spent] of spentByMint) {
    if (spent > allowance(mint)) {
      throw new SolanaSpendGuardError(
        allowance(mint) === 0n
          ? `This transaction would take a token you didn't choose to spend (${mint}). It was stopped before signing; nothing was sent.`
          : 'This transaction would spend more of your token than the amount you entered. It was stopped before signing; nothing was sent.',
      );
    }
  }

  if (expectedOutputMint && expectedOutputMinimum && expectedOutputMinimum > 0n) {
    let received = 0n;
    const extraOutputAccounts = expectedOutputAccounts.filter(a => !tracked.some(t => eq(t.address, a)));
    for (let i = 0; i < tracked.length; i++) {
      if (!eq(tracked[i].mint, expectedOutputMint)) continue;
      const raw = post[i + 1]?.data?.[0];
      const parsed = typeof raw === 'string' ? parseTokenAccount(Uint8Array.from(Buffer.from(raw, 'base64')), encodeBase58) : null;
      if (parsed && parsed.owner === ownerAddress && eq(parsed.mint, expectedOutputMint) && parsed.amount > tracked[i].amount) received += parsed.amount - tracked[i].amount;
    }
    for (let i = 0; i < extraOutputAccounts.length; i++) {
      const raw = post[tracked.length + 1 + i]?.data?.[0];
      const parsed = typeof raw === 'string' ? parseTokenAccount(Uint8Array.from(Buffer.from(raw, 'base64')), encodeBase58) : null;
      if (parsed && parsed.owner === ownerAddress && eq(parsed.mint, expectedOutputMint)) received += parsed.amount;
    }
    if (received < expectedOutputMinimum) throw new SolanaSpendGuardError('This transaction did not deliver the expected output token to your wallet. It was stopped before signing; nothing was sent and nothing was spent.');
  }

  const postLamports = BigInt(post[0]?.lamports ?? 0);
  const lamportsOut = BigInt(preLamports) - postLamports;
  const lamportsAllowed = (spendsSol ? intent.maxSpend : 0n) + overheadLamports;
  if (lamportsOut > lamportsAllowed) {
    throw new SolanaSpendGuardError('This transaction would take more SOL than this trade needs. It was stopped before signing; nothing was sent.');
  }
}

/** The standard wiring: web3.js PublicKeys for the two token programs, bs58 for addresses. */
export async function assertSolanaSpendWithinIntentWeb3(connection: SpendGuardConnection, transaction: unknown, ownerAddress: string, intent: SolanaSpendIntent, tokenAccountConnection?: SpendGuardConnection): Promise<void> {
  const [{PublicKey}, bs58Module] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  const bs58 = bs58Module.default;
  await assertSolanaSpendWithinIntent(connection, transaction, {
    owner: new PublicKey(ownerAddress),
    ownerAddress,
    intent,
    tokenProgramIds: [new PublicKey(TOKEN_PROGRAM), new PublicKey(TOKEN_2022_PROGRAM)],
    tokenAccountConnection,
    encodeBase58: b => bs58.encode(b),
  });
}

/** True when a failed simulation failed only because the wallet lacks SOL for fees/rent — the case Mango's fee sponsorship exists for. */
export function isInsufficientSolSimulation(err: unknown): boolean {
  if (!(err instanceof SolanaSpendGuardError) || !err.simulationFailed) return false;
  const text = `${err.message} ${err.logs.join(' ')}`;
  return /insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent|AccountNotFound/i.test(text);
}
