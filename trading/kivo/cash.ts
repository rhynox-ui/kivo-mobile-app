// Gasless USDC withdrawal (mobile), ported from Mango Pro's sendUsdc: one
// ERC-20 transfer signed on the device and submitted by Relay with Kivo
// paying gas, so a wallet holding only USDC can always move its cash.
// There is no fallback to a gas-paying transfer (that is exactly what used
// to fail with "insufficient ETH for gas" in Mango).

import {encodeFunctionData, isAddress, parseUnits, type Address} from 'viem';
import bs58 from 'bs58';
import {signAndSendSponsoredSolanaStep, type SolanaTransactionSigner} from '../core/executeRelayQuote';
import type {LocalAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES, type ChainKey} from '../core/chainData';
import {getViemChain} from '../core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {cashAssetAddress,cashAssetSymbol,usdcDecimals} from './balances';

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
  const usdc = TOKEN_ADDRESSES.USDC?.[chainKey];
  if (!usdc || !usdc.startsWith('0x')) throw new Error(`Kivo has no verified USDC contract on ${chainKey}.`);
  if (!isAddress(to)) throw new Error('Enter a valid 0x… address.');
  if (to.toLowerCase() === account.address.toLowerCase()) throw new Error('That is this wallet’s own address.');
  if (!/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) <= 0) throw new Error('Enter an amount greater than zero.');
  const data = encodeFunctionData({abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to as Address, parseUnits(amount.trim(), usdcDecimals(chainKey))]});
  return sendEvmCallsViaRelayGasless({
    chain: getViemChain(chainKey),
    fromAddress: account.address as Address,
    account,
    calls: [{to: usdc as Address, value: 0n, data}],
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
  const instructions = [];
  if (!toAtaInfo) instructions.push(splToken.createAssociatedTokenAccountInstruction(from, toAta, to, mint));
  const amountRaw = parseUnits(amountUsdc, 6);
  instructions.push(splToken.createTransferInstruction(fromAta, toAta, from, amountRaw));
  const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({recentBlockhash: blockhash, feePayer: from});
  transaction.add(...instructions);
  transaction.sign(solanaKeypair);
  try {
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, 'confirmed');
    return {hash: signature};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/insufficient lamports/i.test(message)) throw error;
    const signer: SolanaTransactionSigner = {
      publicKey: from,
      async sign(versioned) {
        versioned.sign([solanaKeypair]);
        return versioned;
      },
    };
    const sponsored = await signAndSendSponsoredSolanaStep(
      instructions,
      [],
      signer,
      connection,
      {spend: mintAddress, maxSpend: amountRaw},
    );
    return {hash: sponsored.signature};
  }
}

export async function withdrawUsdc(
  chainKey: ChainKey,
  account: LocalAccount,
  solanaKeypair: InstanceType<typeof import('@solana/web3.js').Keypair>,
  to: string,
  amount: string,
): Promise<{hash: string; requestId?: string}> {
  if (!isValidRecipientAddress(chainKey, to)) {
    throw new Error(`That doesn't look like a valid ${chainKey === 'solana' ? 'Solana' : 'wallet'} address.`);
  }
  if (chainKey === 'solana') return sendSolanaUsdc(account, solanaKeypair, to.trim(), amount);
  return withdrawUsdcGasless({account, chainKey, to, amount});
}

export async function sendUsdc(chainKey: ChainKey, account: LocalAccount, to: string, amount: string): Promise<{hash: string; requestId: string}> {
  return withdrawUsdcGasless({account, chainKey, to, amount});
}
