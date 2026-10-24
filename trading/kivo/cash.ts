// Gasless USDC withdrawal (mobile), ported from Mango Pro's sendUsdc: one
// ERC-20 transfer signed on the device and submitted by Relay with Kivo
// paying gas, so a wallet holding only USDC can always move its cash.
// There is no fallback to a gas-paying transfer (that is exactly what used
// to fail with "insufficient ETH for gas" in Mango).

import {createWalletClient, encodeFunctionData, formatEther, isAddress, parseUnits, type Address, type Chain, type Hex} from 'viem';
import bs58 from 'bs58';
import {executeRelayQuote, signAndSendSponsoredSolanaStep, sponsorRepaymentUsdcUnits, type SolanaTransactionSigner} from '../core/executeRelayQuote';
import {CLASSIC_TOKEN_ACCOUNT_SPACE, rentExemptLamports} from '../core/solanaAccountCreation';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '../core/relayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import type {LocalAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES, assetDecimalsForChain, type ChainKey} from '../core/chainData';
import {getViemChain, publicClientForChainId, transportFor} from '../core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {markFailedOnChain, markMaybeBroadcast, solanaSubmitDefinitelyRejected} from '../core/broadcastState';
import {cashAssetAddress,cashAssetSymbol} from './balances';

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
 * Networks where Kivo's server never sponsors a plain transfer (Ethereum
 * mainnet: gas costs dollars). A transfer there is paid with the wallet's
 * own gas coin, never a dead end: without any, the error says how to move
 * the USDC instead (Convert, which shows its fee first).
 */
export const OWN_GAS_TRANSFER_CHAINS = new Set<ChainKey>(['ethereum']);

/** Sends EVM calls as a normal transaction, the wallet paying gas in its own coin (checked first). */
export async function sendEvmCallsPayingOwnGas(params: {chain: Chain; account: LocalAccount; calls: {to: Address; value: bigint; data: Hex}[]}): Promise<{hash: string; requestId: string}> {
  const {chain, account} = params;
  if (params.calls.length !== 1) throw new Error('Only a single transfer can be sent this way.');
  const call = params.calls[0];
  const client = publicClientForChainId(chain.id);
  const [gas, fees, balance] = await Promise.all([
    client.estimateGas({account: account.address, to: call.to, data: call.data, value: call.value}),
    client.estimateFeesPerGas(),
    client.getBalance({address: account.address}),
  ]);
  const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const cost = (gas * 12n / 10n) * perGas;
  if (balance < cost + call.value) {
    throw new Error(`Kivo doesn't cover gas for transfers on ${chain.name}, and this wallet holds ${formatEther(balance)} ${chain.nativeCurrency.symbol}, about ${formatEther(cost)} short of the network fee. Nothing was sent. Use Convert to move this USDC to Solana (the fee is shown before you confirm), then send it from there.`);
  }
  const wallet = createWalletClient({account, chain, transport: transportFor(chain.id)});
  const hash = await wallet.sendTransaction({account, chain, to: call.to, data: call.data, value: call.value, gas: gas * 12n / 10n});
  try {
    const receipt = await client.waitForTransactionReceipt({hash, timeout: 120_000});
    if (receipt.status !== 'success') throw markFailedOnChain(new Error(`Transaction ${hash} failed on-chain.`), {signature: hash});
  } catch (error) {
    if (error instanceof Error && (error as {kivoFailedOnChain?: boolean}).kivoFailedOnChain) throw error;
    throw markMaybeBroadcast(new Error(`Transaction ${hash} was sent but is not confirmed yet. Do not retry; check its status first.`), {signature: hash});
  }
  return {hash, requestId: ''};
}

/** Kivo pays gas (Relay /execute) except where it never sponsors transfers; there the wallet pays its own gas. */
export function sendTransferCalls(params: {chain: Chain; chainKey: ChainKey; account: LocalAccount; calls: {to: Address; value: bigint; data: Hex}[]}): Promise<{hash: string; requestId: string}> {
  if (OWN_GAS_TRANSFER_CHAINS.has(params.chainKey)) return sendEvmCallsPayingOwnGas(params);
  return sendEvmCallsViaRelayGasless({chain: params.chain, fromAddress: params.account.address as Address, account: params.account, calls: params.calls});
}

export async function withdrawUsdcGasless(params: {account: LocalAccount; chainKey: ChainKey; to: string; amount: string}): Promise<{hash: string; requestId: string}> {
  const {account, chainKey, amount} = params;
  const to = params.to.trim();
  const cashSymbol = cashAssetSymbol(chainKey);
  const cashAddress = cashAssetAddress(chainKey);
  if (!cashAddress || !cashAddress.startsWith('0x')) throw new Error(`Kivo has no verified ${cashSymbol} contract on ${chainKey}.`);
  if (!isAddress(to)) throw new Error('Enter a valid 0x… address.');
  if (to.toLowerCase() === account.address.toLowerCase()) throw new Error('That is this wallet’s own address.');
  if (!/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) <= 0) throw new Error('Enter an amount greater than zero.');
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  const data = encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to as Address, parseUnits(amount.trim(), decimals)]});
  return sendTransferCalls({chain: getViemChain(chainKey), chainKey, account, calls: [{to: cashAddress as Address, value: 0n, data}]});
}

/** Gasless USDC transfer used by NEAR Intents 1Click funding. */
async function sendSolanaUsdc(
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair>,
  toAddress: string,
  amountUsdc: string,
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
  instructions.push(splToken.createTransferInstruction(fromAta, toAta, from, amountRaw));
  const signer: SolanaTransactionSigner = {
    publicKey: from,
    async sign(versioned) {
      versioned.sign([solanaKeypair]);
      return versioned;
    },
  };
  const sponsoredSend = async () => {
    let sendRaw = amountRaw;
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
      if (held !== null && recovery > 0n && held < sendRaw + recovery) {
        sendRaw = held - recovery;
        if (sendRaw <= 0n) throw new Error('Not enough USDC to cover this new address\'s one-time account fee. Nothing was sent.');
        sponsoredInstructions = [instructions[0], splToken.createTransferInstruction(fromAta, toAta, from, sendRaw)];
      }
    }
    const sponsored = await signAndSendSponsoredSolanaStep(sponsoredInstructions, [], signer, connection, {spend: mintAddress, maxSpend: sendRaw}, {allowedAtaOwners: [to.toBase58()]});
    return {hash: sponsored.signature};
  };
  // A USDC-only wallet (the normal Kivo case) holds no SOL at all. Solana
  // then rejects with "no record of a prior credit" instead of "insufficient
  // lamports", so check the balance first: fee plus new-account rent.
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
): Promise<{hash: string; requestId?: string}> {
  if (!isValidRecipientAddress(chainKey, to)) {
    throw new Error(`That doesn't look like a valid ${chainKey === 'solana' ? 'Solana' : 'wallet'} address.`);
  }
  if (chainKey === 'solana') {
    if (!solanaKeypair) throw new Error('This wallet has no Solana account. Nothing was sent.');
    return sendSolanaUsdc(account, solanaKeypair, to.trim(), amount);
  }
  return withdrawUsdcGasless({account, chainKey, to, amount});
}

export async function sendUsdc(chainKey: ChainKey, account: LocalAccount, to: string, amount: string): Promise<{hash: string; requestId: string}> {
  return withdrawUsdcGasless({account, chainKey, to, amount});
}

/**
 * Withdrawal from Kivo's home balance (USDC on Solana) to any network: one
 * Relay route, USDC on Solana -> USDC (USDG on Robinhood) on `chainKey`,
 * delivered straight to `to`. USDC->USDC carries no Relay platform fee and
 * no Kivo fee; Relay's own execution cost (≈$0.02 + destination gas) comes
 * out of the amount and is shown before confirming. The Solana network fee
 * is paid (and absorbed) by Kivo's fee payer; only new token-account rent is
 * recovered in the same transaction.
 */
function homeWithdrawalParams(chainKey: ChainKey, solanaAddress: string, to: string, amount: string) {
  const usdcSolana = TOKEN_ADDRESSES.USDC?.solana;
  if (!usdcSolana) throw new Error('No verified USDC mint for Solana.');
  if (!isValidRecipientAddress(chainKey, to)) throw new Error("That doesn't look like a valid wallet address for this network.");
  return {
    fromChainKey: 'solana' as ChainKey,
    toChainKey: chainKey,
    originCurrency: usdcSolana,
    destinationCurrency: cashAssetAddress(chainKey),
    amountBaseUnits: parseUnits(amount.trim(), 6).toString(),
    userAddress: solanaAddress,
    recipientAddress: to.trim(),
    waiveAppFee: true,
  };
}

/** What the recipient gets for a home withdrawal to another network (shown before confirming). */
export async function quoteHomeWithdrawal(chainKey: ChainKey, solanaAddress: string, to: string, amount: string): Promise<QuoteSummary> {
  return summarizeQuote(await getRelayQuote(homeWithdrawalParams(chainKey, solanaAddress, to, amount)), assetDecimalsForChain(chainKey, cashAssetSymbol(chainKey)) ?? 6);
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
