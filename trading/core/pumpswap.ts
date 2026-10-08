// src/core/pumpswap.ts
//
// Direct PumpSwap integration — the post-graduation AMM pump.fun tokens
// move to once their bonding curve fills, sitting alongside pumpfun.ts's
// own pre-graduation bonding-curve integration. See pumpfun.ts's own
// header for why this app needs either at all (Relay's Solana routing
// goes through Jupiter under the hood, and Jupiter's route construction
// for these newer, non-standard AMMs isn't reliable). Ported from
// mango-mobile's own src/bridge/pumpswap.js, itself a mobile port of
// mango-bridge.jsx's src/pumpswap.js.
//
// Every address/instruction/account-layout/quote-math detail below is
// UNCHANGED from that source — same official npm package
// (@pump-fun/pump-swap-sdk), same verification path (installed source
// read directly): program IDs and PDA seeds from src/sdk/pda.ts,
// instruction account lists from src/idl/pump_amm.json (the program's
// own real IDL), constant-product quote math from src/sdk/buy.ts and
// src/sdk/sell.ts, and full instruction assembly reused directly from
// PumpAmmSdk's own sellBaseInput/buyQuoteInput methods rather than
// hand-derived. Same scope limits too: canonical pool only (index 0,
// SOL-quoted via WSOL), no pre-graduation bonding-curve coverage (see
// pumpfun.ts for that).
//
// GENUINE DIFFERENCE FROM THE MOBILE SOURCE: see pumpfun.ts's own header
// — this app has two signing paths (local seed-phrase Keypair, or
// Particle's MPC signer for a Google-login session), not one.

import {PublicKey, TransactionMessage, VersionedTransaction, type Connection} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  canonicalPumpPoolPda,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  sellBaseInput as sellBaseInputMath,
  buyQuoteInput as buyQuoteInputMath,
  type SwapSolanaState,
} from '@pump-fun/pump-swap-sdk';
import type {DerivedAccounts} from '../wallet/keys';

// 1% — same default tolerance this app's own EVM fallback DEX
// integrations (uniswapV3.ts, sushiswapV2.ts, etc.) apply when nothing
// more specific is available.
const DEFAULT_SLIPPAGE_PCT = 1;

/**
 * Returns the canonical PumpSwap pool address for a token mint if one
 * actually exists on-chain, or null if this token has no PumpSwap pool
 * (never graduated, or isn't a pump.fun token at all).
 */
export async function pumpSwapPoolForMint(connection: Connection, mintAddress: string): Promise<PublicKey | null> {
  try {
    const mint = new PublicKey(mintAddress);
    const poolKey = canonicalPumpPoolPda(mint);
    const info = await connection.getAccountInfo(poolKey);
    return info ? poolKey : null;
  } catch {
    return null;
  }
}

async function loadSwapState(connection: Connection, poolKey: PublicKey, userAddress: string) {
  const onlineSdk = new OnlinePumpAmmSdk(connection);
  return onlineSdk.swapSolanaState(poolKey, new PublicKey(userAddress));
}

function commonMathFields(state: SwapSolanaState) {
  return {
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: state.pool.coinCreator,
    creator: state.pool.creator,
    feeConfig: state.feeConfig,
  };
}

/** Quotes selling `amountBaseUnits` of the token for native SOL. Returns null when this token has no PumpSwap pool. */
export async function quotePumpSwapSell({connection, mintAddress, amountBaseUnits, userAddress}: {connection: Connection; mintAddress: string; amountBaseUnits: bigint; userAddress: string}): Promise<{amountOut: bigint} | null> {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) return null;
  const state = await loadSwapState(connection, poolKey, userAddress);
  const {uiQuote} = sellBaseInputMath({...commonMathFields(state), base: new BN(amountBaseUnits.toString()), slippage: 0});
  return {amountOut: BigInt(uiQuote.toString())};
}

/** Quotes spending `quoteBaseUnits` of native SOL (lamports) to buy the token. Returns null when this token has no PumpSwap pool. */
export async function quotePumpSwapBuy({connection, mintAddress, quoteBaseUnits, userAddress}: {connection: Connection; mintAddress: string; quoteBaseUnits: bigint; userAddress: string}): Promise<{amountOut: bigint} | null> {
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) return null;
  const state = await loadSwapState(connection, poolKey, userAddress);
  const {base} = buyQuoteInputMath({...commonMathFields(state), quote: new BN(quoteBaseUnits.toString()), slippage: 0});
  return {amountOut: BigInt(base.toString())};
}

/**
 * Full build-sign-send for a direct PumpSwap trade: `side: "sell"`
 * spends `amountBaseUnits` of the token for native SOL, `side: "buy"`
 * spends `amountBaseUnits` lamports of native SOL for the token. Signs
 * locally for a seed-phrase session; through Particle's MPC signer for a
 * Google-login session — see this file's own header. Throws (never
 * silently no-ops) when this mint has no PumpSwap pool — the caller's
 * own try/catch (fallbackDex.ts) is what falls through to pump.fun's
 * bonding curve, or the original Relay error, for that case.
 */
export async function executePumpSwapTrade({
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
  const payerKey = new PublicKey(session.solana.address);
  const poolKey = await pumpSwapPoolForMint(connection, mintAddress);
  if (!poolKey) {
    throw new Error('This token has no PumpSwap pool.');
  }
  const state = await loadSwapState(connection, poolKey, session.solana.address);
  const instructions =
    side === 'sell'
      ? await PUMP_AMM_SDK.sellBaseInput(state, new BN(amountBaseUnits.toString()), slippagePct)
      : await PUMP_AMM_SDK.buyQuoteInput(state, new BN(amountBaseUnits.toString()), slippagePct);

  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({payerKey, instructions, recentBlockhash: blockhash}).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  // Same real fix as the mobile source's own established pattern —
  // simulate before broadcasting (or before spending a Particle
  // remote-signing round trip): this pool's own reserves genuinely too
  // thin for this size, real slippage exceeded, etc, never even reaches
  // the network as a wasted send.
  const sim = await connection.simulateTransaction(transaction, {commitment: 'confirmed'});
  if (sim.value.err) {
    throw new Error(`PumpSwap simulation failed: ${JSON.stringify(sim.value.err)}`);
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
