// src/wallet/useAvailableBalance.ts
//
// Exact scoped port of mango-mobile's own src/wallet/useAvailableBalance.ts
// — the "how much can I actually send" state TokenTradeScreen.tsx needs to
// turn its 25/50/75/MAX quick-percent row from permanently disabled into
// real. Deliberately generic rather than chain-aware: the fetchBalance
// callback the caller passes in already knows whether it's reading a
// native or token balance on which chain (see TokenTradeScreen.tsx's own
// fetchBalance) — this hook only centralizes the cancellation-safe async
// state and the Max formula, not the fetch itself. See that mobile file's
// own header for the fuller Max-formula reasoning (verified against
// Rabby's/MetaMask's real send-Max logic).

import {useEffect, useRef, useState} from 'react';

export function useAvailableBalance(fetchBalance: (() => Promise<number>) | null, deps: unknown[]) {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!fetchBalance);
  const requestId = useRef(0);

  useEffect(() => {
    if (!fetchBalance) {
      setBalance(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    fetchBalance()
      .then(b => {
        if (requestId.current === id) {
          setBalance(b);
          setLoading(false);
        }
      })
      .catch(() => {
        if (requestId.current === id) {
          setBalance(null);
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {balance, loading};
}

/** balance minus fee for a native asset (clamped to 0), or the full balance for a token. */
export function computeMaxAmount({balance, isNativeAsset, feeNative}: {balance: number | null; isNativeAsset: boolean; feeNative: number}): number {
  if (balance === null) {
    return 0;
  }
  if (!isNativeAsset) {
    return balance;
  }
  const max = balance - feeNative;
  return max > 0 ? max : 0;
}

/**
 * Formats a number for an amount input: no trailing zeros, no scientific
 * notation, and truncates (never rounds up) past 8 decimal places — see
 * mango-mobile's own useAvailableBalance.ts for the full precision
 * reasoning (a rounded-up MAX can re-parse to more raw units than the
 * wallet actually holds and revert on-chain).
 */
export function formatAmountForInput(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  const [whole, frac = ''] = n.toFixed(100).split('.');
  const truncatedFrac = frac.slice(0, 8).replace(/0+$/, '');
  return truncatedFrac ? `${whole}.${truncatedFrac}` : whole;
}
