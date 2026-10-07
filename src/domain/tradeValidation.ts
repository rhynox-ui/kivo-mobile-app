import type { TradeSide } from './trade';

export const TRADE_PRESETS = [25, 50, 75, 100] as const;
export type TradePreset = typeof TRADE_PRESETS[number];

export function parseTradeAmount(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function validateTradeAmount(value: string, availableUsd: number | null): string | null {
  const amount = parseTradeAmount(value);
  if (amount == null) return 'Enter an amount greater than zero.';
  if (availableUsd != null && amount > availableUsd) return 'Amount is above the available balance.';
  return null;
}

export function labelForSide(side: TradeSide): string {
  return side === 'buy' ? 'You pay' : 'You sell';
}

export function presetAmount(availableUsd: number | null, preset: TradePreset): string | null {
  if (availableUsd == null || !Number.isFinite(availableUsd) || availableUsd <= 0) return null;
  return ((availableUsd * preset) / 100).toFixed(2);
}
