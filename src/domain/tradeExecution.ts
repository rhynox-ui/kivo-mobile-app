import type { TradeIntent } from './trade';

export type TradeExecutionStatus = 'idle' | 'awaiting-signature' | 'submitted' | 'confirmed' | 'failed';

export type TradeExecutionResult = {
  status: TradeExecutionStatus;
  intent: TradeIntent;
  txHash: string | null;
  error: string | null;
};

export function canExecuteTrade(intent: TradeIntent): boolean {
  return Boolean(intent.inputToken.address && intent.outputToken.address && intent.amount.trim());
}
