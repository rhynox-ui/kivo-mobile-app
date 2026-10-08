import {createPublicClient, createWalletClient, type Abi, type PublicClient, type WalletClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {transportFor, viemChainForChainId} from './chainRegistry.ts';
import type {DerivedAccounts} from '../wallet/keys';

export type EvmSigner = {
  kind: 'local';
  address: `0x${string}`;
  walletClient: WalletClient;
};

export function signerAndPublicClientForChain(chainId: number, session: DerivedAccounts): {signer: EvmSigner; publicClient: PublicClient} {
  const viemChain = viemChainForChainId(chainId);
  if (!viemChain) throw new Error(`No EVM chain configured for chain id ${chainId}.`);
  const transport = transportFor(chainId);
  const publicClient = createPublicClient({chain: viemChain, transport});
  const account = privateKeyToAccount(session.evm.privateKey as `0x${string}`);
  const walletClient = createWalletClient({account, chain: viemChain, transport});
  return {signer: {kind: 'local', address: account.address, walletClient}, publicClient};
}

export async function writeContractAs(
  signer: EvmSigner,
  req: {address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint},
): Promise<`0x${string}`> {
  return signer.walletClient.writeContract({
    account: signer.walletClient.account!,
    chain: signer.walletClient.chain,
    ...req,
  } as never);
}

export async function sendTransactionAs(
  signer: EvmSigner,
  req: {to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint},
): Promise<`0x${string}`> {
  return signer.walletClient.sendTransaction({
    account: signer.walletClient.account!,
    chain: signer.walletClient.chain,
    ...req,
  } as never);
}
