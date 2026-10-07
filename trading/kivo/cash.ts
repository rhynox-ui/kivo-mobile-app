// Gasless USDC withdrawal (mobile), ported from Mango Pro's sendUsdc: one
// ERC-20 transfer signed on the device and submitted by Relay with Kivo
// paying gas, so a wallet holding only USDC can always move its cash.
// There is no fallback to a gas-paying transfer (that is exactly what used
// to fail with "insufficient ETH for gas" in Mango).

import {encodeFunctionData, isAddress, parseUnits, type Address} from 'viem';
import type {LocalAccount} from 'viem/accounts';
import {TOKEN_ADDRESSES, type ChainKey} from '../core/chainData';
import {getViemChain} from '../core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '../core/relayGaslessEvm';
import {usdcDecimals} from './balances';

const ERC20_TRANSFER_ABI = [{type: 'function', name: 'transfer', inputs: [{name: 'to', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'bool'}], stateMutability: 'nonpayable'}] as const;

export function isValidEvmRecipient(address: string): boolean {
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
