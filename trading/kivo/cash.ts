// Gasless USDC withdrawal (mobile), ported from Mango Pro's sendUsdc: one
// ERC-20 transfer signed on the device and submitted by Relay with Kivo
// paying gas, so a wallet holding only USDC can always move its cash.
// There is no fallback to a gas-paying transfer (that is exactly what used
// to fail with "insufficient ETH for gas" in Mango).

import {encodeFunctionData, isAddress, parseUnits, type Address} from 'viem';
import bs58 from 'bs58';
import {executeRelayQuote, getSolanaFeePayerPublicKey, signAndSendSponsoredSolanaStep, sponsorRepaymentUsdcUnits, type SolanaTransactionSigner} from '../core/executeRelayQuote';
import {CLASSIC_TOKEN_ACCOUNT_SPACE, rentExemptLamports} from '../core/solanaAccountCreation';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '../core/relayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import type {LocalAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES, assetDecimalsForChain, type ChainKey} from '../core/chainData';
import {getViemChain} from '../core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {markFailedOnChain, markMaybeBroadcast, solanaSubmitDefinitelyRejected} from '../core/broadcastState';
import {cashAssetAddress,cashAssetSymbol} from './balances';
import {DEV_FEE_WALLET, withdrawalFeeUnits, withdrawalFeeUsd} from '../core/fees';

const ERC20_TRANSFER_ABI = [{type: 'function', name: 'transfer', inputs: [{name: 'to', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'}] as const;

export function isValidEvmRecipient(address: string): boolean {
  return isAddress(address.trim());
}

export function isValidRecipientAddress(chainKey: ChainKey, address: string): boolean {
  if (chainKey === 'solana') {
    try { return bs58.decode(address.trim()).length === 32; } catch { return false; }
  }
  return isAddress(address.trim());
}

/**
 * How Kivo's withdrawal fee (fees.ts withdrawalFeeUsd) is paid:
 *  - 'deduct': taken out of `amount` (a user's withdrawal: they withdraw
 *    `amount`, the recipient gets `amount - fee`, like an exchange);
 *  - 'on-top': the recipient gets exactly `amount` and the fee is paid on top
 *    (a deposit address that must receive an exact amount, e.g. NEAR Intents);
 *  - 'none': no fee (Solana cash moves only; Kivo's server refuses to sponsor
 *    an EVM transfer without it, so EVM treats 'none' as 'on-top').
 */
export type WithdrawalFeeMode = 'deduct' | 'on-top' | 'none';

/** Kivo's withdrawal fee and what the recipient receives, for `amount` withdrawn on `chainKey` (null when the amount doesn't cover the fee). */
export function withdrawalBreakdown(chainKey: ChainKey, amount: number): {feeUsd: number; receive: number} | null {
  const feeUsd = withdrawalFeeUsd(chainKey);
  if (!Number.isFinite(amount) || amount <= feeUsd) return null;
  return {feeUsd, receive: Math.round((amount - feeUsd) * 1e6) / 1e6};
}

/** Error shown when an amount does not cover the withdrawal fee. */
export function withdrawalTooSmallMessage(chainKey: ChainKey): string {
  return `The amount must be more than the $${withdrawalFeeUsd(chainKey).toFixed(2)} withdrawal fee.`;
}

/**
 * The calls of a gas-free EVM withdrawal: the transfer to `to` and Kivo's
 * withdrawal fee to Kivo's fee wallet, in one batch that Kivo's server
 * sponsors only when the fee is there (web/server/relay.ts withdrawalProblem).
 */
export function evmWithdrawalCalls(chainKey: ChainKey, to: string, amountUnits: bigint, feeMode: WithdrawalFeeMode = 'deduct'): {to: Address; value: bigint; data: `0x${string}`}[] {
  const cashSymbol = cashAssetSymbol(chainKey);
  const cashAddress = cashAssetAddress(chainKey);
  if (!cashAddress || !cashAddress.startsWith('0x')) throw new Error(`Kivo has no verified ${cashSymbol} contract on ${chainKey}.`);
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  const fee = withdrawalFeeUnits(chainKey, decimals);
  const send = feeMode === 'deduct' ? amountUnits - fee : amountUnits;
  if (send <= 0n) throw new Error(`${withdrawalTooSmallMessage(chainKey)} Nothing was sent.`);
  const transfer = (recipient: string, units: bigint) => encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [recipient as Address, units]});
  return [
    {to: cashAddress as Address, value: 0n, data: transfer(to, send)},
    {to: cashAddress as Address, value: 0n, data: transfer(DEV_FEE_WALLET, fee)},
  ];
}

export async function withdrawUsdcGasless(params: {account: LocalAccount; chainKey: ChainKey; to: string; amount: string; feeMode?: WithdrawalFeeMode}): Promise<{hash: string; requestId: string}> {
  const {account, chainKey, amount} = params;
  const to = params.to.trim();
  const cashSymbol = cashAssetSymbol(chainKey);
  const cashAddress = cashAssetAddress(chainKey);
  if (!cashAddress || !cashAddress.startsWith('0x')) throw new Error(`Kivo has no verified ${cashSymbol} contract on ${chainKey}.`);
  if (!isAddress(to)) throw new Error('Enter a valid 0x… address.');
  if (to.toLowerCase() === account.address.toLowerCase()) throw new Error('That is this wallet’s own address.');
  if (!/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) <= 0) throw new Error('Enter an amount greater than zero.');
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  const feeMode = params.feeMode === 'none' ? 'on-top' : params.feeMode ?? 'deduct';
  return sendEvmCallsViaRelayGasless({
    chain: getViemChain(chainKey),
    fromAddress: account.address as Address,
    account,
    calls: evmWithdrawalCalls(chainKey, to, parseUnits(amount.trim(), decimals), feeMode),
  });
}

/** Gasless USDC transfer used by NEAR Intents 1Click funding. */
async function sendSolanaUsdc(
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair>,
  toAddress: string,
  amountUsdc: string,
  feeMode: WithdrawalFeeMode = 'none',
): Promise<{hash: string}> {
  const mintAddress = TOKEN_ADDRESSES.USDC?.solana;
  if (!mintAddress) throw new Error('No verified USDC mint for Solana.');
  const [{Connection, PublicKey, Transaction}, splToken] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);
  const connection = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
  const mint = new PublicKey(mintAddress);
  const from = solanaKeypair.publicKey;
  const to = new PublicKey(toAddress);
  const fromAta = await splToken.getAssociatedTokenAddress(mint, from);
  const toAta = await splToken.getAssociatedTokenAddress(mint, to);
  const toAtaInfo = await connection.getAccountInfo(toAta);
  const instructions: InstanceType<typeof import('@solana/web3.js').TransactionInstruction>[] = [];
  if (!toAtaInfo) instructions.push(splToken.createAssociatedTokenAccountInstruction(from, toAta, to, mint));
  const amountRaw = parseUnits(amountUsdc, 6);
  // Kivo's withdrawal fee, paid in USDC to the sponsor's USDC account in this
  // same transaction (next to any rent repayment). A withdrawal always goes
  // through Kivo's sponsor then: Kivo pays the Solana fee the fee covers.
  const feeRaw = feeMode === 'none' ? 0n : withdrawalFeeUnits('solana', 6);
  let feeIx: InstanceType<typeof import('@solana/web3.js').TransactionInstruction> | null = null;
  if (feeRaw > 0n) {
    const sponsorUsdcAta = await splToken.getAssociatedTokenAddress(mint, new PublicKey(await getSolanaFeePayerPublicKey()));
    if (!await connection.getAccountInfo(sponsorUsdcAta, 'confirmed')) throw new Error("Kivo's withdrawal fee account isn't ready. Nothing was sent; try again later.");
    feeIx = splToken.createTransferInstruction(fromAta, sponsorUsdcAta, from, feeRaw);
  }
  const recipientRaw = feeMode === 'deduct' ? amountRaw - feeRaw : amountRaw;
  if (recipientRaw <= 0n) throw new Error(`${withdrawalTooSmallMessage('solana')} Nothing was sent.`);
  instructions.push(splToken.createTransferInstruction(fromAta, toAta, from, recipientRaw));
  if (feeIx) instructions.push(feeIx);
  const signer: SolanaTransactionSigner = {
    publicKey: from,
    async sign(versioned) {
      versioned.sign([solanaKeypair]);
      return versioned;
    },
  };
  const sponsoredSend = async () => {
    let sendRaw = recipientRaw;
    let sponsoredInstructions = instructions;
    if (!toAtaInfo) {
      // Kivo fronts the recipient's one-time USDC account rent, and this
      // wallet repays it (at cost; Kivo absorbs the network fee) in USDC in
      // the same transaction, as Kivo's sponsor requires. A "send
      // everything" leaves exactly that much behind.
      const [recovery, held] = await Promise.all([
        sponsorRepaymentUsdcUnits(rentExemptLamports(CLASSIC_TOKEN_ACCOUNT_SPACE)),
        connection.getTokenAccountBalance(fromAta, 'confirmed').then(r => BigInt(r.value.amount)).catch(() => null),
      ]);
      if (held !== null && recovery > 0n && held < sendRaw + feeRaw + recovery) {
        sendRaw = held - feeRaw - recovery;
        if (sendRaw <= 0n) throw new Error('Not enough USDC to cover this new address\'s one-time account fee. Nothing was sent.');
        sponsoredInstructions = [instructions[0], splToken.createTransferInstruction(fromAta, toAta, from, sendRaw), ...(feeIx ? [feeIx] : [])];
      }
    }
    const sponsored = await signAndSendSponsoredSolanaStep(sponsoredInstructions, [], signer, connection, {spend: mintAddress, maxSpend: sendRaw + feeRaw}, {allowedAtaOwners: [to.toBase58()]});
    return {hash: sponsored.signature};
  };
  // A USDC-only wallet (the normal Kivo case) holds no SOL at all. Solana
  // then rejects with "no record of a prior credit" instead of "insufficient
  // lamports", so check the balance first: fee plus new-account rent.
  if (feeRaw > 0n) return sponsoredSend();
  const needLamports = 10_000 + (toAtaInfo ? 0 : await connection.getMinimumBalanceForRentExemption(165));
  const haveLamports = await connection.getBalance(from, 'confirmed');
  if (haveLamports < needLamports) return sponsoredSend();

  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({recentBlockhash: blockhash, feePayer: from});
  transaction.add(...instructions);
  transaction.sign(solanaKeypair);
  // Known before broadcasting, so a later failure can still point at this transaction.
  const signature = transaction.signature ? bs58.encode(transaction.signature) : '';
  try {
    await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    // Rejected in preflight, so nothing was broadcast: safe to sponsor instead.
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient lamports|no record of a prior credit|AccountNotFound|InsufficientFundsFor(Fee|Rent)/i.test(message)) return sponsoredSend();
    throw solanaSubmitDefinitelyRejected(error) ? error : markMaybeBroadcast(error, {signature});
  }
  try {
    const result = await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
    if (result.value.err) throw markFailedOnChain(new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`), {signature});
  } catch (error) {
    if (error instanceof Error && (error as {kivoFailedOnChain?: boolean}).kivoFailedOnChain) throw error;
    throw markMaybeBroadcast(new Error(`Transaction ${signature} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature});
  }
  return {hash: signature};
}

export async function withdrawUsdc(
  chainKey: ChainKey,
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair> | null,
  to: string,
  amount: string,
  feeMode: WithdrawalFeeMode,
): Promise<{hash: string; requestId?: string}> {
  if (!isValidRecipientAddress(chainKey, to)) {
    throw new Error(`That doesn't look like a valid ${chainKey === 'solana' ? 'Solana' : 'wallet'} address.`);
  }
  if (chainKey === 'solana') {
    if (!solanaKeypair) throw new Error('This wallet has no Solana account. Nothing was sent.');
    return sendSolanaUsdc(account, solanaKeypair, to.trim(), amount, feeMode);
  }
  return withdrawUsdcGasless({account, chainKey, to, amount, feeMode});
}

export async function sendUsdc(chainKey: ChainKey, account: LocalAccount, to: string, amount: string): Promise<{hash: string; requestId: string}> {
  return withdrawUsdcGasless({account, chainKey, to, amount});
}

/** Relay app fees are capped at 5% by Kivo's server: the smallest bridged withdrawal is the fee x 20. */
const HOME_WITHDRAWAL_MAX_FEE_BPS = 500n;

/** Kivo's withdrawal fee on a bridged home withdrawal of `amountUnits` (USDC, 6 decimals), as Relay app-fee bps (rounded up). */
export function homeWithdrawalFeeBps(amountUnits: bigint): bigint {
  const fee = withdrawalFeeUnits('solana', 6);
  return amountUnits > 0n ? (fee * 10_000n + amountUnits - 1n) / amountUnits : HOME_WITHDRAWAL_MAX_FEE_BPS + 1n;
}

/** The smallest amount a home balance can withdraw to another network (USD). */
export function minHomeBridgeWithdrawalUsd(): number {
  return withdrawalFeeUsd('solana') * 10_000 / Number(HOME_WITHDRAWAL_MAX_FEE_BPS);
}

/**
 * Withdrawal from Kivo's home balance (USDC on Solana) to any network: one
 * Relay route, USDC on Solana -> USDC (USDG on Robinhood) on `chainKey`,
 * delivered straight to `to`. Kivo's withdrawal fee (fees.ts, $0.10 from the
 * home balance) is the route's app fee; Relay's own execution cost (≈$0.02 +
 * destination gas) also comes out of the amount. Both are shown before
 * confirming. The Solana network fee is paid by Kivo's fee payer; new
 * token-account rent is recovered in the same transaction.
 */
function homeWithdrawalParams(chainKey: ChainKey, solanaAddress: string, to: string, amount: string) {
  const usdcSolana = TOKEN_ADDRESSES.USDC?.solana;
  if (!usdcSolana) throw new Error('No verified USDC mint for Solana.');
  if (!isValidRecipientAddress(chainKey, to)) throw new Error("That doesn't look like a valid wallet address for this network.");
  const amountUnits = parseUnits(amount.trim(), 6);
  const feeBps = homeWithdrawalFeeBps(amountUnits);
  if (feeBps > HOME_WITHDRAWAL_MAX_FEE_BPS) throw new Error(`Withdrawals to another network must be at least $${minHomeBridgeWithdrawalUsd().toFixed(2)}.`);
  return {
    fromChainKey: 'solana' as ChainKey,
    toChainKey: chainKey,
    originCurrency: usdcSolana,
    destinationCurrency: cashAssetAddress(chainKey),
    amountBaseUnits: amountUnits.toString(),
    userAddress: solanaAddress,
    recipientAddress: to.trim(),
    waiveAppFee: true,
    withdrawalFeeBps: feeBps.toString(),
  };
}

/** What the recipient gets for a home withdrawal to another network (shown before confirming). */
export async function quoteHomeWithdrawal(chainKey: ChainKey, solanaAddress: string, to: string, amount: string): Promise<QuoteSummary & {kivoFeeUsd: number}> {
  const params = homeWithdrawalParams(chainKey, solanaAddress, to, amount);
  const summary = summarizeQuote(await getRelayQuote(params), assetDecimalsForChain(chainKey, cashAssetSymbol(chainKey)) ?? 6);
  const kivoFeeUsd = Number(BigInt(params.amountBaseUnits) * BigInt(params.withdrawalFeeBps) / 10_000n) / 1e6;
  return {...summary, kivoFeeUsd};
}

/** How far below the reviewed "they receive" amount the executed quote may land before Kivo refuses to sign it. */
export const HOME_WITHDRAWAL_RECEIVE_TOLERANCE = 0.01;

/**
 * Whether a fresh quote still delivers what the person reviewed: at least the
 * reviewed amount minus HOME_WITHDRAWAL_RECEIVE_TOLERANCE (1%), and never
 * less than the reviewed amount minus 0.05 for tiny withdrawals.
 */
export function receiveWithinTolerance(reviewed: number, executed: number | null): boolean {
  if (executed === null || !Number.isFinite(executed) || !Number.isFinite(reviewed) || reviewed <= 0) return false;
  const floor = reviewed - Math.max(reviewed * HOME_WITHDRAWAL_RECEIVE_TOLERANCE, 0.000001);
  return executed >= floor;
}

export async function withdrawFromHome(chainKey: ChainKey, accounts: DerivedAccounts, to: string, amount: string, reviewedReceive?: number): Promise<{hash: string; requestId?: string; pending?: boolean}> {
  if (!accounts.solana?.address) throw new Error('This wallet has no Solana account. Nothing was sent.');
  const params = homeWithdrawalParams(chainKey, accounts.solana.address, to, amount);
  const decimals = assetDecimalsForChain(chainKey, cashAssetSymbol(chainKey)) ?? 6;
  const guardedQuote = async () => {
    const quote = await getRelayQuote(params);
    if (reviewedReceive !== undefined) {
      const executed = Number(summarizeQuote(quote, decimals).receivedAmountFormatted);
      if (!receiveWithinTolerance(reviewedReceive, Number.isFinite(executed) ? executed : null)) {
        throw new Error(`The price moved: the recipient would now get ${Number.isFinite(executed) ? executed.toFixed(4) : 'an unknown amount'} instead of the ${reviewedReceive.toFixed(4)} you reviewed. Nothing was sent. Review the withdrawal again.`);
      }
    }
    return quote;
  };
  const result = await executeRelayQuote(await guardedQuote(), accounts, undefined, {requote: guardedQuote});
  if (result.status === 'refunded') throw markFailedOnChain(new Error('The transfer could not be completed and was refunded to your Solana USDC.'), {signature: result.txHashes[0], requestId: result.requestId ?? undefined});
  return {hash: result.txHashes[result.txHashes.length - 1] ?? '', requestId: result.requestId ?? undefined, pending: result.status === 'pending'};
}
