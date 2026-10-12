// src/core/solanaTxIntent.ts
//
// Ported verbatim (logic unchanged, typed for this repo) from
// mango-bridge.jsx's own src/solanaTxIntent.js — the Solana half of the
// pre-sign intent check; see txIntentFirewall.ts for the EVM half and
// the reasoning behind both.
//
// The audit finding this exists for: a Solana path that simulates
// before signing proves the transaction will SUCCEED but says nothing
// about whether it does what the user asked. A transaction that drains
// the wallet simulates perfectly.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not try to prove a route
// is correct by decoding every AMM's instruction layout — Solana routes
// go through whichever program the solver picked, and a client-side
// allowlist of program IDs would break on the first new venue Relay
// adds. Attempting that would produce a check that fails honest trades,
// which is worse than no check.
//
// WHAT IT DOES. One thing that cannot legitimately be wrong, as a hard
// block, and an inventory of things worth knowing as warnings:
//
//   BLOCK — the fee payer must be either the user's own account, or an
//   explicitly-passed sponsor (Mango's own fee-payer service, fetched
//   from our own backend — see executeRelayQuote.ts's sponsored-signing
//   path). A transaction presented to this wallet whose fee payer is
//   neither is not this user's trade.
//
//   BLOCK — the user's own account must appear as a REQUIRED SIGNER
//   somewhere in the transaction. This is what still ties a
//   sponsor-paid transaction back to the user: the sponsor covering the
//   fee doesn't mean the sponsor is authorizing the trade — the user's
//   own signature, on the actual swap/transfer instructions, still has
//   to be there.
//
//   BLOCK — an spl-token Approve or SetAuthority, because they grant or
//   change standing authority over the user's token account.
//   CloseAccount is different: Relay/Jupiter routes can legitimately use
//   it to clean up an emptied token account or WSOL account. It is allowed
//   only when the user's own signer is both the close authority and the
//   destination for the recovered lamports.
//
// Parsing is deliberately structural — compiled instruction program IDs
// and the first byte of each instruction's data — so it works on both a
// legacy Transaction and a VersionedTransaction without depending on
// any SDK's decoder staying stable.

const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// spl-token instruction discriminators (the first byte of the data),
// from the program's own instruction enum ordering.
const SPL_APPROVE = 4;
const SPL_SET_AUTHORITY = 6;
const SPL_CLOSE_ACCOUNT = 9;
const SPL_APPROVE_CHECKED = 13;

export class SolanaIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaIntentError';
  }
}

export type DescribedSolanaTransaction = {
  feePayer: string | null;
  // Every account this transaction requires a real signature from — the
  // fee payer is always one of these, but for a sponsored transaction
  // it is not the ONLY one: the user's own account has to be here too,
  // via whichever swap/transfer instruction actually moves their funds.
  requiredSigners: string[];
  instructions: {programId: string | null; firstDataByte: number | null; accounts: string[]}[];
};

// Duck-typed against @solana/web3.js's real Transaction/
// VersionedTransaction shapes without importing the SDK here — this
// file stays a pure, dependency-free structural check, same as the
// original it's ported from.
type Base58Key = {toBase58?: () => string} | string | null | undefined;
type LegacyLikeTransaction = {feePayer?: Base58Key; instructions?: {programId?: Base58Key; data?: Uint8Array; keys?: {pubkey?: Base58Key; isSigner?: boolean}[]}[]};
type VersionedLikeTransaction = {
  message?: {
    header?: {numRequiredSignatures?: number};
    staticAccountKeys?: Base58Key[];
    compiledInstructions?: {programIdIndex: number; accountKeyIndexes?: number[]; data?: Uint8Array}[];
    getAccountKeys?: (args?: {addressLookupTableAccounts?: unknown[]}) => {get: (index: number) => Base58Key | undefined};
  };
};
export type SolanaLikeTransaction = {
  feePayer?: Base58Key;
  instructions?: LegacyLikeTransaction['instructions'];
  // Deliberately duck-typed: web3.js MessageV0 has readonly/internal
  // fields whose exact TypeScript shape changes between SDK releases.
  message?: any;
};

function keyToBase58(key: Base58Key): string | null {
  if (!key) return null;
  if (typeof key === 'string') return key;
  return key.toBase58?.() ?? null;
}

/**
 * Pulls out just the parts this file reasons about, from either
 * transaction shape.
 *
 * Returns null when the transaction isn't a shape we recognise —
 * callers treat that as "cannot check", not as "safe", and say so.
 */
export function describeSolanaTransaction(
  transaction: SolanaLikeTransaction | null | undefined,
  options?: {addressLookupTableAccounts?: unknown[]},
): DescribedSolanaTransaction | null {
  if (!transaction || typeof transaction !== 'object') return null;

  // VersionedTransaction: a compiled message with a static key table.
  // The first `numRequiredSignatures` keys (fee payer always at index 0)
  // are exactly the accounts this transaction requires a signature from
  // — that's how @solana/web3.js itself orders the table when compiling.
  const message = transaction.message;
  if (message && Array.isArray(message.staticAccountKeys) && Array.isArray(message.compiledInstructions)) {
    const keys = message.staticAccountKeys.map((k: any) => keyToBase58(k) ?? String(k));
    const numRequiredSignatures = message.header?.numRequiredSignatures ?? 1;
    let resolvedKeys: {get: (index: number) => Base58Key | undefined} | null = null;
    try {
      resolvedKeys = message.getAccountKeys?.({
        addressLookupTableAccounts: options?.addressLookupTableAccounts,
      }) ?? null;
    } catch {
      resolvedKeys = null;
    }
    return {
      feePayer: keys[0] ?? null,
      requiredSigners: keys.slice(0, numRequiredSignatures),
      instructions: message.compiledInstructions.map((ix: any) => ({
        programId: keys[ix.programIdIndex] ?? null,
        firstDataByte: ix.data?.length ? ix.data[0] : null,
        accounts: (ix.accountKeyIndexes ?? []).map((index: number) =>
          keyToBase58(resolvedKeys?.get(index) ?? keys[index]) ?? '',
        ),
      })),
    };
  }

  // Legacy Transaction: instructions carry their own program ids. There
  // is no single header to read required signers from, so they're
  // derived the same way @solana/web3.js's own Message compiler does —
  // the fee payer, plus the union of every account any instruction
  // marks isSigner.
  if (Array.isArray(transaction.instructions)) {
    const feePayer = keyToBase58(transaction.feePayer);
    const requiredSigners = new Set<string>();
    if (feePayer) requiredSigners.add(feePayer);
    for (const ix of transaction.instructions) {
      for (const key of ix.keys ?? []) {
        if (!key.isSigner) continue;
        const pubkey = keyToBase58(key.pubkey);
        if (pubkey) requiredSigners.add(pubkey);
      }
    }
    return {
      feePayer,
      requiredSigners: [...requiredSigners],
      instructions: transaction.instructions.map(ix => ({
        programId: keyToBase58(ix.programId),
        firstDataByte: ix.data?.length ? ix.data[0] : null,
        accounts: (ix.keys ?? []).map(key => keyToBase58(key.pubkey) ?? ''),
      })),
    };
  }

  return null;
}

/**
 * Blocks on the conditions that cannot legitimately hold; returns
 * warning strings for the rest.
 *
 * expectedSigner is the user's own base58 address — this is always
 * required to be a real signer of the transaction, sponsored or not.
 * expectedFeePayer defaults to expectedSigner (the normal, user-pays
 * case) but can be set to a different, explicitly-trusted address (see
 * executeRelayQuote.ts's sponsored-signing path, which passes Mango's
 * own fee-payer address here) — sponsoring the fee is not the same
 * thing as authorizing the trade, so the two are checked separately.
 *
 * base58 is case-sensitive, so these are compared exactly — never
 * lowercased the way an EVM address safely can be.
 */
export function assertSolanaTransactionMatchesIntent(
  transaction: SolanaLikeTransaction | null | undefined,
  {expectedSigner, expectedFeePayer, addressLookupTableAccounts}: {
    expectedSigner?: string | null;
    expectedFeePayer?: string | null;
    addressLookupTableAccounts?: unknown[];
  },
): string[] {
  const described = describeSolanaTransaction(transaction, {addressLookupTableAccounts});
  if (!described) {
    // Promoted from a warning to a hard block (real, confirmed finding
    // from an uploaded audit's MANGO-H02, verified against this exact
    // function before acting): an inability to inspect a transaction is
    // not evidence it's safe, and a wallet should never sign what it
    // cannot verify. Low risk of blocking a legitimate trade — every
    // transaction this app itself ever builds (from Relay's returned
    // instructions, via @solana/web3.js's own TransactionMessage/
    // VersionedTransaction, or a legacy Transaction) always matches one
    // of the two shapes describeSolanaTransaction recognizes; reaching
    // this branch means something already went wrong upstream (a
    // malformed/tampered object), which is exactly the case a wallet
    // should refuse, not warn about and sign anyway.
    throw new SolanaIntentError(
      "This trade's transaction could not be inspected before signing (unrecognised transaction format). " +
        'It was stopped before signing; nothing was sent and nothing was spent.',
    );
  }

  const allowedFeePayer = expectedFeePayer ?? expectedSigner;
  if (allowedFeePayer && described.feePayer && described.feePayer !== allowedFeePayer) {
    const expectedWho = expectedFeePayer ? `the expected fee payer (${allowedFeePayer})` : `your wallet (${allowedFeePayer})`;
    throw new SolanaIntentError(
      `This transaction would be paid for by ${described.feePayer}, not by ${expectedWho}. ` +
        'It was stopped before signing; nothing was sent and nothing was spent.',
    );
  }

  if (expectedSigner && !described.requiredSigners.includes(expectedSigner)) {
    throw new SolanaIntentError(
      `This transaction does not require a signature from your wallet (${expectedSigner}) — it would not actually be authorized by you. ` +
        'It was stopped before signing; nothing was sent and nothing was spent.',
    );
  }

  // Promoted from warnings to hard blocks (real, confirmed finding from
  // an uploaded audit's MANGO-H03, verified against this exact function
  // before acting) — this file's own header already concluded "None of
  // the three belongs in a swap route" when these were first added as
  // warnings; that conclusion hasn't changed, only the enforcement has.
  // This app's own two Solana transaction sources were checked directly
  // before promoting: executeRelayQuote.ts's cost-recovery addition only
  // ever appends an SPL Transfer (discriminant 3) and, at most, an
  // Associated-Token-Account Create — neither is one of these four — and
  // this app requests Solana's native-SOL identifier from Relay, never
  // WSOL (see executeRelayQuote.ts's own header), so there's no
  // wrap/unwrap step of this app's own construction that would need a
  // CloseAccount either. A legitimate route hitting this block produces
  // a loud, specific, immediately-actionable error naming exactly which
  // instruction tripped it — recoverable by relaxing that one case —
  // which is safer than the alternative this replaces: a warning nothing
  // in this app's UI surfaced, on an instruction class real Solana
  // wallet-drain patterns actually use.
  const warnings: string[] = [];
  for (const ix of described.instructions) {
    if (ix.programId !== SPL_TOKEN_PROGRAM_ID && ix.programId !== SPL_TOKEN_2022_PROGRAM_ID) continue;
    if (ix.firstDataByte === SPL_APPROVE || ix.firstDataByte === SPL_APPROVE_CHECKED) {
      throw new SolanaIntentError(
        'This route grants a delegate standing authority over one of your token accounts, which a swap does not normally need. ' +
          'It was stopped before signing; nothing was sent and nothing was spent.',
      );
    } else if (ix.firstDataByte === SPL_SET_AUTHORITY) {
      throw new SolanaIntentError(
        'This route changes the authority on one of your token accounts, which a swap does not normally need. ' +
          'It was stopped before signing; nothing was sent and nothing was spent.',
      );
    } else if (ix.firstDataByte === SPL_CLOSE_ACCOUNT) {
      // Verified against Relay's real Solana routes: Jupiter/dflow swap
      // payloads can legitimately CloseAccount after a swap (for example
      // when an emptied token account or WSOL account is cleaned up).
      // Do not blanket-block the instruction. Instead require the two
      // security properties that matter for a wallet: the close authority
      // must be the user's signer and the reclaimed lamports must return
      // to that same signer. A route cannot use this as a hidden rent drain.
      const closeSource = ix.accounts[0];
      const closeDestination = ix.accounts[1];
      const closeAuthority = ix.accounts[2];
      if (
        !expectedSigner ||
        !closeSource ||
        closeDestination !== expectedSigner ||
        closeAuthority !== expectedSigner
      ) {
        throw new SolanaIntentError(
          'This route closes a token account without returning its recovered funds to your wallet. ' +
            'It was stopped before signing; nothing was sent and nothing was spent.',
        );
      }
    }
  }
  return warnings;
}
