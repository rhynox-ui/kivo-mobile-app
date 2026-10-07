import type { TokenRef } from './types';

export type TradeSide = 'buy' | 'sell';
export type TradeIntent = { side: TradeSide; inputToken: TokenRef; outputToken: TokenRef; amount: string; slippageBps: number };
export type TradeStatus = 'idle' | 'quoting' | 'ready' | 'signing' | 'submitted' | 'failed';
