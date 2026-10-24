// Re-checks a submitted transfer so a "pending" result can settle without the
// person sending again.
import {createPublicClient} from 'viem';
import {transportFor, viemChainForChainId} from '../core/chainRegistry';
import {fetchRelayStatus} from './execute';

export type TransferCheck = 'confirmed' | 'failed' | 'pending';

const SOLANA_STATUS_RPC_URL = 'https://solana-rpc.publicnode.com';
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

async function solanaStatus(signature: string): Promise<TransferCheck> {
  const res = await fetch(SOLANA_STATUS_RPC_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[signature], {searchTransactionHistory: true}]}),
  });
  const body = await res.json() as {result?: {value?: Array<{err: unknown; confirmationStatus?: string | null} | null>}};
  const status = body.result?.value?.[0];
  if (status?.err) return 'failed';
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'confirmed';
  return 'pending';
}

async function evmStatus(chainId: number, hash: `0x${string}`): Promise<TransferCheck> {
  const client = createPublicClient({chain: viemChainForChainId(chainId), transport: transportFor(chainId)});
  try {
    const receipt = await client.getTransactionReceipt({hash});
    return receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'pending';
  }
}

/** Best current status of a transfer. Relay's requestId wins (it covers the whole route); a failed read is "pending". */
export async function checkTransferStatus(input: {txHash?: string | null; requestId?: string | null; chainId?: number | null}): Promise<TransferCheck> {
  try {
    if (input.requestId) {
      const status = await fetchRelayStatus(input.requestId);
      if (status === 'success') return 'confirmed';
      if (status === 'failure' || status === 'refund') return 'failed';
      if (status !== 'unknown') return 'pending';
    }
    if (input.txHash && SOLANA_SIGNATURE.test(input.txHash)) return await solanaStatus(input.txHash);
    if (input.txHash && EVM_HASH.test(input.txHash) && input.chainId) return await evmStatus(input.chainId, input.txHash as `0x${string}`);
  } catch {
    return 'pending';
  }
  return 'pending';
}
