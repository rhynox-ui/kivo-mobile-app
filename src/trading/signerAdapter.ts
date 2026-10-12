import type { TradeIntent } from '../domain/trade';

export type SignerAdapter = {
  signAndSubmit(intent: TradeIntent, serializedTransaction: string): Promise<{ txHash: string }>;
};

/**
 * Signing is intentionally an adapter. UI/domain code must never receive
 * seed phrases or private keys.
 */
