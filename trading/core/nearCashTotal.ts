export type CashTotal = { total: number; complete: boolean };

/**
 * Include USDC held on NEAR in the displayed portfolio total without adding
 * NEAR to the Relay-spendable chain rows. NEAR is funded through 1Click.
 */
export function withNearCash(total: CashTotal | null, nearBalance: number | null): CashTotal | null {
  if (!total) return null;
  if (nearBalance === null || !Number.isFinite(nearBalance) || nearBalance < 0) {
    return { ...total, complete: false };
  }
  return { ...total, total: total.total + nearBalance };
}
