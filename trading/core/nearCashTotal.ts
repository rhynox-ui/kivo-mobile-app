export type CashTotal = { total: number; complete: boolean };

/**
 * Include USDC held on NEAR in the displayed portfolio total without adding
 * NEAR to the Relay-spendable chain rows. NEAR is funded through 1Click.
 */
export function withNearCash(total: CashTotal | null, nearBalance: number): CashTotal | null {
  if (!total) return null;
  const safeNearBalance = Number.isFinite(nearBalance) && nearBalance > 0 ? nearBalance : 0;
  return { ...total, total: total.total + safeNearBalance };
}
