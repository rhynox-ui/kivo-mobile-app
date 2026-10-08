// src/core/pumpfun.ts
//
// Direct pump.fun BONDING CURVE integration — the Solana half of this
// app's same-chain fallback (see fallbackDex.ts's own header for why EVM
// already had a four-provider fallback chain while Solana had none: a
// Solana same-chain trade routed through Relay's SDK goes through
// Jupiter under the hood, and Jupiter's routing math for pump.fun's
// non-standard bonding-curve/AMM mechanics isn't reliable — mango-mobile
// hit a real, live "insufficient lamports" failure whose size had
// nothing to do with real network fees). Ported from mango-mobile's own
// src/bridge/pumpfun.js, which is itself a mobile port of
// mango-bridge.jsx's src/pumpfun.js — same real integration, third copy.
//
// Every address/instruction/state detail below is UNCHANGED from that
// source — same official npm package (@pump-fun/pump-sdk), same
// verification path (installed source read directly, not guessed):
// bonding-curve account fields from src/state.ts, full instruction
// assembly from src/sdk.ts's own PumpSdk class (PUMP_SDK singleton),
// state fetching from src/onlineSdk.ts's OnlinePumpSdk class. Same
// disclosed gap too: neither this file nor the SDK expose a standalone
// quote/pricing function, so the quote math below is the standard public
// pump.fun constant-product formula, not fee-adjusted — same reason this
// uses a wider default slippage (5%) than pumpswap.ts's (1%). SOL-quoted
// bonding curves only.
//
// GENUINE DIFFERENCE FROM THE MOBILE SOURCE: mobile IS the wallet (one
// signing path, straight through its own embedded Keypair). This app has
// two: a local seed-phrase session signs the same way, but a
// Google-login (Particle MPC) session has no local key at all — the
// built transaction is serialized unsigned and handed to Particle's own
// signAndSendSolanaTransactionViaParticle instead, same dual-path
// pattern already established in sendUsdc.ts and executeRelayQuote.ts.
//
// METRO COMPATIBILITY: confirmed live against mango-mobile's real Metro
// config (`react-native bundle --platform android --dev false`) for both
// @pump-fun/pump-sdk and @pump-fun/pump-swap-sdk together — see that
// file's own header for the full Node-vs-Metro module-resolution
// reasoning (an unrelated @pump-fun/agent-payments-sdk import that only
// Node's strict ESM loader chokes on). This app's own scripts/verify-*.mjs
// suite never imports this file, so that failure mode can't recur here
// either, but the same Metro bundle check was re-run against this app's
// own config before this file was wired in, not assumed to carry over.

import {PublicKey, TransactionMessage, VersionedTransaction, type Connection} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import {OnlinePumpSdk, PUMP_SDK} from '@pump-fun/pump-sdk';
import {NATIVE_MINT, TOKEN_PROGRAM_ID} from '@solana/spl-token';
import type {DerivedAccounts} from '../wallet/keys';

// Wider than pumpswap.ts's 1% default — see this file's own header on
// why (no fee model for this side, unlike PumpSwap's).
const DEFAULT_SLIPPAGE_PCT = 5;

type BondingCurve = {
  complete: boolean;
  quoteMint?: PublicKey;
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
  isMayhemMode?: boolean;
};

async function pumpFunCurveForMint(connection: Connection, mintAddress: string): Promise<BondingCurve | null> {
  try {
    const onlineSdk = new OnlinePumpSdk(connection);
    const mint = new PublicKey(mintAddress);
    const bondingCurve = (await onlineSdk.fetchBondingCurve(mint)) as BondingCurve;
    if (bondingCurve.complete) return null;
    // SOL-quoted only — see this file's own header.
    if (bondingCurve.quoteMint && !bondingCurve.quoteMint.equals(NATIVE_MINT) && !bondingCurve.quoteMint.equals(PublicKey.default)) return null;
    return bondingCurve;
  } catch {
    return null;
  }
}

// Standard pump.fun constant-product bonding-curve formula — identical
// to the mobile/site source, see this file's own header on why fees
// aren't modeled here.
function quoteBuyFromReserves(bondingCurve: BondingCurve, solIn: BN): BN {
  const {virtualTokenReserves, virtualQuoteReserves} = bondingCurve;
  const newVirtualQuoteReserves = virtualQuoteReserves.add(solIn);
  const newVirtualTokenReserves = virtualQuoteReserves.mul(virtualTokenReserves).div(newVirtualQuoteReserves);
  const tokensOut = virtualTokenReserves.sub(newVirtualTokenReserves);
  return tokensOut.lt(new BN(0)) ? new BN(0) : tokensOut;
}

function quoteSellFromReserves(bondingCurve: BondingCurve, tokensIn: BN): BN {
  const {virtualTokenReserves, virtualQuoteReserves} = bondingCurve;
  const newVirtualTokenReserves = virtualTokenReserves.add(tokensIn);
  const newVirtualQuoteReserves = virtualQuoteReserves.mul(virtualTokenReserves).div(newVirtualTokenReserves);
  const solOut = virtualQuoteReserves.sub(newVirtualQuoteReserves);
  return solOut.lt(new BN(0)) ? new BN(0) : solOut;
}

/** Quotes buying the token by spending `quoteBaseUnits` lamports of native SOL. Returns null when this mint has no active bonding curve. */
export async function quotePumpFunBuy({connection, mintAddress, quoteBaseUnits}: {connection: Connection; mintAddress: string; quoteBaseUnits: bigint}): Promise<{amountOut: bigint} | null> {
  const bondingCurve = await pumpFunCurveForMint(connection, mintAddress);
  if (!bondingCurve) return null;
  const amountOut = quoteBuyFromReserves(bondingCurve, new BN(quoteBaseUnits.toString()));
  return {amountOut: BigInt(amountOut.toString())};
}

/** Quotes selling `amountBaseUnits` of the token for native SOL. Returns null when this mint has no active bonding curve. */
export async function quotePumpFunSell({connection, mintAddress, amountBaseUnits}: {connection: Connection; mintAddress: string; amountBaseUnits: bigint}): Promise<{amountOut: bigint} | null> {
  const bondingCurve = await pumpFunCurveForMint(connection, mintAddress);
  if (!bondingCurve) return null;
  const amountOut = quoteSellFromReserves(bondingCurve, new BN(amountBaseUnits.toString()));
  return {amountOut: BigInt(amountOut.toString())};
}

/**
 * Full build-sign-send for a direct pump.fun bonding-curve trade.
 * `side: "buy"` spends `amountBaseUnits` lamports of native SOL for the
 * token; `side: "sell"` spends `amountBaseUnits` of the token for native
 * SOL. Signs locally for a seed-phrase session; through Particle's MPC
 * signer for a Google-login session (session.authMethod === 'google') —
 * see this file's own header. Throws when this mint has no active
 * bonding curve — the caller's own try/catch (fallbackDex.ts) is what
 * falls through to PumpSwap for that case.
 */
export async function executePumpFunTrade({
  connection,
  session,
  mintAddress,
  side,
  amountBaseUnits,
  slippagePct = DEFAULT_SLIPPAGE_PCT,
}: {
  connection: Connection;
  session: DerivedAccounts;
  mintAddress: string;
  side: 'buy' | 'sell';
  amountBaseUnits: bigint;
  slippagePct?: number;
}): Promise<{signature: string}> {
  const user = new PublicKey(session.solana.address);
  const onlineSdk = new OnlinePumpSdk(connection);
  const mint = new PublicKey(mintAddress);
  const global = await onlineSdk.fetchGlobal();

  let instructions;
  if (side === 'buy') {
    const {bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo} = await onlineSdk.fetchBuyState(mint, user);
    if (bondingCurve.complete) {
      throw new Error('This token has already graduated off the bonding curve.');
    }
    const quoteAmount = new BN(amountBaseUnits.toString());
    const tokenAmount = quoteBuyFromReserves(bondingCurve as BondingCurve, quoteAmount);
    instructions = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint,
      user,
      amount: tokenAmount,
      solAmount: quoteAmount,
      slippage: slippagePct,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  } else {
    const {bondingCurveAccountInfo, bondingCurve} = await onlineSdk.fetchSellState(mint, user);
    if (bondingCurve.complete) {
      throw new Error('This token has already graduated off the bonding curve.');
    }
    const tokenAmount = new BN(amountBaseUnits.toString());
    const quoteAmount = quoteSellFromReserves(bondingCurve as BondingCurve, tokenAmount);
    instructions = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      mint,
      user,
      amount: tokenAmount,
      solAmount: quoteAmount,
      slippage: slippagePct,
      tokenProgram: TOKEN_PROGRAM_ID,
      mayhemMode: (bondingCurve as BondingCurve).isMayhemMode ?? false,
    });
  }

  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({payerKey: user, instructions, recentBlockhash: blockhash}).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  // Same real fix as the mobile source's own established pattern —
  // simulate before broadcasting (or before spending a Particle
  // remote-signing round trip), so a doomed transaction never even
  // reaches the network as a wasted send.
  const sim = await connection.simulateTransaction(transaction, {commitment: 'confirmed'});
  if (sim.value.err) {
    throw new Error(`pump.fun simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  let signature: string;
  if (session.authMethod === 'google') {
    const {signAndSendSolanaTransactionViaParticle} = await import('../wallet/particleSigning.ts');
    signature = await signAndSendSolanaTransactionViaParticle(transaction.serialize());
  } else {
    const {Keypair} = await import('@solana/web3.js');
    const keypair = Keypair.fromSecretKey(bs58.decode(session.solana.privateKey));
    transaction.sign([keypair]);
    signature = bs58.encode(transaction.signatures[0]);
    await connection.sendRawTransaction(transaction.serialize());
  }

  await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
  return {signature};
}
