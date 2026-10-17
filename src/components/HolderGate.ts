import type { CommunityGate } from '@kivo/shared/api/types';
import { CHAIN_LABEL } from '@kivo/trading/core/chainData';

/** Networks the server accepts for holder gates (same list as the token picker, minus non-EVM/Solana ones). */
export const GATE_CHAINS = ['solana', 'ethereum', 'base', 'bnb', 'robinhood', 'arbitrum', 'avalanche', 'abstract', 'hyperevm', 'ink', 'plasma', 'unichain', 'xlayer'];

export function networkLabel(chain: string): string {
  return (CHAIN_LABEL as Record<string, string>)[chain] ?? chain;
}

/** "🔒 Holders: ≥ 1000 $SYM (Solana)" */
export function gateSummary(gate: CommunityGate): string {
  return `🔒 Holders: ≥ ${gate.minAmount} $${gate.symbol} (${networkLabel(gate.chain)})`;
}

/** A positive decimal amount, as the server parses it. */
export function validGateAmount(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim()) && Number(value) > 0;
}
