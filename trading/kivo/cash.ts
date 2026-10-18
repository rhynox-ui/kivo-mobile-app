// Gasless USDC withdrawal (mobile), ported from Mango Pro's sendUsdc: one
// ERC-20 transfer signed on the device and submitted by Relay with Kivo
// paying gas, so a wallet holding only USDC can always move its cash.
// There is no fallback to a gas-paying transfer (that is exactly what used
// to fail with "insufficient ETH for gas" in Mango).

import {encodeFunctionData, isAddress, parseUnits, type Address} from 'viem';
import bs58 from 'bs58';
import {executeRelayQuote, signAndSendSponsoredSolanaStep, sponsorshipRecoveryUsdcUnits, type SolanaTransactionSigner} from '../core/executeRelayQuote';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '../core/relayQuote';
import type {DerivedAccounts} from '../wallet/keys';
import {fetchWalletPrices} from '../core/walletPrices';
import type {LocalAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES, assetDecimalsForChain, type ChainKey} from '../core/chainData';
import {getViemChain} from '../core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
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
  return sendEvmCallsViaRelayGasless({
    chain: getViemChain(chainKey),
    fromAddress: account.address as Address,
    account,
    calls: [{to: cashAddress as Address, value: 0n, data}],
  });
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
      // Kivo pays the recipient's one-time USDC account rent and recovers it
      // (at cost; Kivo absorbs the network fee) from this wallet's USDC in the same transaction. A
      // "send everything" leaves exactly that much behind so it is never lost.
      const [rent, prices, held] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(165),
        fetchWalletPrices().catch(() => ({}) as Record<string, number>),
        connection.getTokenAccountBalance(fromAta, 'confirmed').then(r => BigInt(r.value.amount)).catch(() => null),
      ]);
      const recovery = BigInt(sponsorshipRecoveryUsdcUnits(rent, prices.SOL ?? 0));
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
  try {
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
    return {hash: signature};
  } catch (error) {
    // Rejected in preflight, so nothing was broadcast: safe to sponsor instead.
    const message = error instanceof Error ? error.message : String(error);
    if (!/insufficient lamports|no record of a prior credit|AccountNotFound|InsufficientFundsFor(Fee|Rent)/i.test(message)) throw error;
    return sponsoredSend();
  }
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

export async function withdrawFromHome(chainKey: ChainKey, accounts: DerivedAccounts, to: string, amount: string): Promise<{hash: string; requestId?: string}> {
  if (!accounts.solana?.address) throw new Error('This wallet has no Solana account. Nothing was sent.');
  const params = homeWithdrawalParams(chainKey, accounts.solana.address, to, amount);
  const result = await executeRelayQuote(await getRelayQuote(params), accounts, undefined, {requote: () => getRelayQuote(params)});
  if (result.status === 'refunded') throw new Error('The transfer could not be completed and was refunded to your Solana USDC.');
  return {hash: result.txHashes[result.txHashes.length - 1] ?? '', requestId: result.requestId ?? undefined};
}
