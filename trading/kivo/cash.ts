// USDC withdrawals (mobile). Kivo pays the gas on every network, Ethereum
// included, and each withdrawal pays Kivo's flat withdrawal fee (fees.ts) out
// of the amount, so a wallet holding only USDC can always move its cash. If
// Kivo can't sponsor one at that moment, the app offers a higher fee or the
// wallet's own gas coin, with the cost shown first: never a dead end, and
// never a silent switch to a gas-paying transfer.

import {createWalletClient, encodeFunctionData, isAddress, parseUnits, type Address, type Hex} from 'viem';
import bs58 from 'bs58';
import {executeRelayQuote, getSolanaFeePayerPublicKey, signAndSendSponsoredSolanaStep, sponsorRepaymentUsdcUnits, type SolanaTransactionSigner} from '../core/executeRelayQuote';
import {CLASSIC_TOKEN_ACCOUNT_SPACE, rentExemptLamports} from '../core/solanaAccountCreation';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '../core/relayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import type {LocalAccount} from 'viem/accounts';
import {MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, assetDecimalsForChain, type ChainKey} from '../core/chainData';
import {getViemChain, publicClientForChainId, transportFor} from '../core/chainRegistry';
import {fetchWalletPrices} from '../core/walletPrices';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {classifyTransferError, markFailedOnChain, markMaybeBroadcast, solanaSubmitDefinitelyRejected} from '../core/broadcastState';
import {cashAssetAddress,cashAssetSymbol} from './balances';
import {DEV_FEE_WALLET, splitWithdrawal, withdrawalFeeUnits, withdrawalFeeUsd} from '../core/fees';

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
export function evmWithdrawalCalls(chainKey: ChainKey, to: string, amountUnits: bigint, feeMode: WithdrawalFeeMode = 'deduct', feeMultiplier = 1n): {to: Address; value: bigint; data: `0x${string}`}[] {
  const cashSymbol = cashAssetSymbol(chainKey);
  const cashAddress = cashAssetAddress(chainKey);
  if (!cashAddress || !cashAddress.startsWith('0x')) throw new Error(`Kivo has no verified ${cashSymbol} contract on ${chainKey}.`);
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  const fee = withdrawalFeeUnits(chainKey, decimals) * (feeMultiplier > 1n ? feeMultiplier : 1n);
  const send = feeMode === 'deduct' ? amountUnits - fee : amountUnits;
  if (send <= 0n) throw new Error(`${withdrawalTooSmallMessage(chainKey)} Nothing was sent.`);
  const transfer = (recipient: string, units: bigint) => encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [recipient as Address, units]});
  return [
    {to: cashAddress as Address, value: 0n, data: transfer(to, send)},
    {to: cashAddress as Address, value: 0n, data: transfer(DEV_FEE_WALLET, fee)},
  ];
}

export async function withdrawUsdcGasless(params: {account: LocalAccount; chainKey: ChainKey; to: string; amount: string; feeMode?: WithdrawalFeeMode; feeMultiplier?: bigint}): Promise<{hash: string; requestId: string}> {
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
    calls: evmWithdrawalCalls(chainKey, to, parseUnits(amount.trim(), decimals), feeMode, params.feeMultiplier),
  });
}

/** Multiplier for the "network is busy" retry: the fee Kivo's sponsorship may spend rises with it. */
export const BUSY_WITHDRAWAL_FEE_MULTIPLIER = 3n;

/**
 * A gas-free withdrawal that pays a higher withdrawal fee (BUSY_WITHDRAWAL_FEE_MULTIPLIER
 * x the table), for when gas is above the normal fee and Relay refused to
 * sponsor it: Kivo's server lets Relay spend up to the fee actually paid.
 */
export function busyWithdrawalFeeUsd(chainKey: ChainKey): number {
  return withdrawalFeeUsd(chainKey) * Number(BUSY_WITHDRAWAL_FEE_MULTIPLIER);
}

/** What paying gas from the wallet's own ETH/BNB/... costs for this withdrawal (estimated, shown before confirming). */
export type SelfPaidEstimate = {costNative: number; costUsd: number | null; symbol: string; enough: boolean; haveNative: number; costWei: bigint; haveWei: bigint};

/** One plain EVM transfer this wallet signs and pays gas for. */
export type SelfPaidCall = {to: Address; data: Hex; value: bigint};

/** Any EVM asset to a friend: the native coin as value, an ERC-20 as transfer(). */
export function evmAssetTransferCall(asset: {kind: string; address: string}, to: string, raw: bigint): SelfPaidCall {
  if (!isAddress(to)) throw new Error('Enter a valid 0x… address.');
  if (raw <= 0n) throw new Error('Enter an amount greater than zero.');
  if (asset.kind === 'native') return {to: to as Address, data: '0x', value: raw};
  if (!isAddress(asset.address)) throw new Error('This token has no valid contract address. Nothing was sent.');
  return {to: asset.address as Address, data: encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to as Address, raw]}), value: 0n};
}

export function selfPaidWithdrawalCall(chainKey: ChainKey, to: string, amount: string, feeMode: WithdrawalFeeMode) {
  const cashSymbol = cashAssetSymbol(chainKey);
  const cashAddress = cashAssetAddress(chainKey);
  if (!cashAddress || !cashAddress.startsWith('0x')) throw new Error(`Kivo has no verified ${cashSymbol} contract on ${chainKey}.`);
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  const gross = parseUnits(amount.trim(), decimals);
  // Same amount reaches the recipient as reviewed; paying its own gas, the
  // wallet pays Kivo no withdrawal fee (it keeps it).
  const send = feeMode === 'deduct' ? gross - withdrawalFeeUnits(chainKey, decimals) : gross;
  if (send <= 0n) throw new Error(`${withdrawalTooSmallMessage(chainKey)} Nothing was sent.`);
  return {to: cashAddress as Address, data: encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to as Address, send]})};
}

export async function estimateSelfPaidWithdrawal(chainKey: ChainKey, from: string, to: string, amount: string, feeMode: WithdrawalFeeMode = 'deduct'): Promise<SelfPaidEstimate> {
  return estimateSelfPaidCall(chainKey, from, {...selfPaidWithdrawalCall(chainKey, to.trim(), amount, feeMode), value: 0n});
}

/** Gas for one self-paid call, and whether the wallet's native coin covers it plus any value sent. */
export async function estimateSelfPaidCall(chainKey: ChainKey, from: string, call: SelfPaidCall): Promise<SelfPaidEstimate> {
  const client = publicClientForChainId(MAINNET_CHAIN_IDS[chainKey]);
  const [gas, fees, balance, prices] = await Promise.all([
    client.estimateGas({account: from as Address, to: call.to, data: call.data, value: call.value}).catch(() => call.data === '0x' ? 21_000n : 80_000n),
    client.estimateFeesPerGas().catch(async () => ({maxFeePerGas: await client.getGasPrice()})),
    client.getBalance({address: from as Address}),
    fetchWalletPrices().catch(() => ({} as Record<string, number>)),
  ]);
  const perGas = (fees as {maxFeePerGas?: bigint; gasPrice?: bigint}).maxFeePerGas ?? (fees as {gasPrice?: bigint}).gasPrice ?? 0n;
  // 20% headroom on both, like a wallet's own estimate.
  const costWei = (gas * 12n / 10n) * (perGas * 12n / 10n);
  const symbol = NATIVE_SYMBOL[chainKey];
  const costNative = Number(costWei) / 1e18;
  const price = prices[symbol];
  return {costNative, costUsd: price ? costNative * price : null, symbol, enough: balance >= costWei + call.value, haveNative: Number(balance) / 1e18, costWei, haveWei: balance};
}

/**
 * The fallback when Kivo can't sponsor gas: a plain transfer this wallet signs
 * and pays gas for in its own ETH/BNB/..., no Kivo fee. Only after the person
 * saw estimateSelfPaidWithdrawal's cost.
 */
export async function withdrawUsdcSelfPaid(params: {account: LocalAccount; chainKey: ChainKey; to: string; amount: string; feeMode?: WithdrawalFeeMode}): Promise<{hash: string}> {
  const to = params.to.trim();
  if (!isAddress(to)) throw new Error('Enter a valid 0x… address.');
  const call = selfPaidWithdrawalCall(params.chainKey, to, params.amount, params.feeMode ?? 'deduct');
  return sendSelfPaidCall({account: params.account, chainKey: params.chainKey, call: {...call, value: 0n}});
}

/** Signs and sends one call paying gas in the wallet's own coin, then waits for its receipt. */
export async function sendSelfPaidCall(params: {account: LocalAccount; chainKey: ChainKey; call: SelfPaidCall}): Promise<{hash: string}> {
  const {account, chainKey, call} = params;
  const chain = getViemChain(chainKey);
  const walletClient = createWalletClient({account, chain, transport: transportFor(chain.id)});
  const client = publicClientForChainId(chain.id);
  const hash = await walletClient.sendTransaction({account, chain, to: call.to, data: call.data, value: call.value});
  try {
    const receipt = await client.waitForTransactionReceipt({hash, timeout: 120_000});
    if (receipt.status !== 'success') throw markFailedOnChain(new Error(`Transaction ${hash} failed on-chain.`), {signature: hash});
  } catch (error) {
    if (error instanceof Error && (error as {kivoFailedOnChain?: boolean}).kivoFailedOnChain) throw error;
    throw markMaybeBroadcast(new Error(`Transaction ${hash} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature: hash});
  }
  return {hash};
}

/** Gasless USDC transfer used by NEAR Intents 1Click funding. */
async function sendSolanaUsdc(
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair>,
  toAddress: string,
  amountUsdc: string,
  feeMode: WithdrawalFeeMode = 'none',
): Promise<{hash: string; selfPaid?: boolean}> {
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
  const needLamports = 10_000 + (toAtaInfo ? 0 : await connection.getMinimumBalanceForRentExemption(165));
  let selfPaid = false;
  if (feeRaw > 0n) {
    // A withdrawal: Kivo's sponsor pays the network fee and the withdrawal fee
    // covers it. If the sponsor can't take it (unavailable, low on SOL...), the
    // withdrawal still goes: this wallet pays the Solana fee from its own SOL
    // and no Kivo fee is charged. The recipient gets what was reviewed.
    try {
      return await sponsoredSend();
    } catch (error) {
      if (classifyTransferError(error).state !== 'not-sent') throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const haveLamports = await connection.getBalance(from, 'confirmed').catch(() => 0);
      if (haveLamports < needLamports) {
        throw new Error(`Kivo couldn't pay the Solana network fee for this withdrawal right now (${reason.replace(/\.?\s*Nothing was (sent|signed)[^.]*\.?/gi, '').trim() || 'sponsor unavailable'}), and this wallet has no SOL to pay it itself. Nothing was sent. Try again in a few minutes, or add about ${(needLamports / 1e9 + 0.001).toFixed(3)} SOL to pay the fee yourself.`);
      }
      selfPaid = true;
    }
  } else {
    const haveLamports = await connection.getBalance(from, 'confirmed');
    if (haveLamports < needLamports) return sponsoredSend();
  }

  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({recentBlockhash: blockhash, feePayer: from});
  // Paying its own fee, the wallet pays Kivo no withdrawal fee.
  transaction.add(...instructions.filter(ix => ix !== feeIx));
  transaction.sign(solanaKeypair);
  // Known before broadcasting, so a later failure can still point at this transaction.
  const signature = transaction.signature ? bs58.encode(transaction.signature) : '';
  try {
    await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    // Rejected in preflight, so nothing was broadcast: safe to sponsor instead.
    const message = error instanceof Error ? error.message : String(error);
    if (!selfPaid && /insufficient lamports|no record of a prior credit|AccountNotFound|InsufficientFundsFor(Fee|Rent)/i.test(message)) return sponsoredSend();
    throw solanaSubmitDefinitelyRejected(error) ? error : markMaybeBroadcast(error, {signature});
  }
  try {
    const result = await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
    if (result.value.err) throw markFailedOnChain(new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`), {signature});
  } catch (error) {
    if (error instanceof Error && (error as {kivoFailedOnChain?: boolean}).kivoFailedOnChain) throw error;
    throw markMaybeBroadcast(new Error(`Transaction ${signature} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature});
  }
  return {hash: signature, ...(selfPaid ? {selfPaid: true} : {})};
}

export async function withdrawUsdc(
  chainKey: ChainKey,
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair> | null,
  to: string,
  amount: string,
  feeMode: WithdrawalFeeMode,
): Promise<{hash: string; requestId?: string; selfPaid?: boolean}> {
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

/**
 * Withdrawal from Kivo's home balance (USDC on Solana) to any network: one
 * Relay route, USDC on Solana -> USDC (USDG on Robinhood) on `chainKey`,
 * delivered straight to `to`. Kivo's withdrawal fee (fees.ts, $0.10 from the
 * home balance) comes off the amount and is paid in USDC to Kivo's Solana
 * sponsor inside the route's own Solana transaction (so the sponsor never
 * quota-limits it); Relay bridges the rest, its own cost (≈$0.02 +
 * destination gas) coming out of that. Both are shown before confirming.
 */
function homeWithdrawalParams(chainKey: ChainKey, solanaAddress: string, to: string, amount: string) {
  const usdcSolana = TOKEN_ADDRESSES.USDC?.solana;
  if (!usdcSolana) throw new Error('No verified USDC mint for Solana.');
  if (!isValidRecipientAddress(chainKey, to)) throw new Error("That doesn't look like a valid wallet address for this network.");
  const split = splitWithdrawal('solana', parseUnits(amount.trim(), 6), 6);
  if (!split) throw new Error(withdrawalTooSmallMessage('solana'));
  return {
    fromChainKey: 'solana' as ChainKey,
    toChainKey: chainKey,
    originCurrency: usdcSolana,
    destinationCurrency: cashAssetAddress(chainKey),
    amountBaseUnits: split.receiveUnits.toString(),
    userAddress: solanaAddress,
    recipientAddress: to.trim(),
    waiveAppFee: true,
    feeUnits: split.feeUnits,
  };
}

/** What the recipient gets for a home withdrawal to another network (shown before confirming). */
export async function quoteHomeWithdrawal(chainKey: ChainKey, solanaAddress: string, to: string, amount: string): Promise<QuoteSummary & {kivoFeeUsd: number}> {
  const {feeUnits, ...params} = homeWithdrawalParams(chainKey, solanaAddress, to, amount);
  const summary = summarizeQuote(await getRelayQuote(params), assetDecimalsForChain(chainKey, cashAssetSymbol(chainKey)) ?? 6);
  return {...summary, kivoFeeUsd: Number(feeUnits) / 1e6};
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
  const {feeUnits, ...params} = homeWithdrawalParams(chainKey, accounts.solana.address, to, amount);
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
  const result = await executeRelayQuote(await guardedQuote(), accounts, undefined, {requote: guardedQuote, solanaWithdrawalFeeUnits: feeUnits});
  if (result.status === 'refunded') throw markFailedOnChain(new Error('The transfer could not be completed and was refunded to your Solana USDC.'), {signature: result.txHashes[0], requestId: result.requestId ?? undefined});
  return {hash: result.txHashes[result.txHashes.length - 1] ?? '', requestId: result.requestId ?? undefined, pending: result.status === 'pending'};
}
