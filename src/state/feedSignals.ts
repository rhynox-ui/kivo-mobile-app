// For You signals sent from the feed: which posts the viewer actually looked
// at (60% on screen for a second), and which tokens their wallet holds. Only
// sent once social is already on; never prompts a signature.

import { fetchPortfolio } from '@kivo/trading/kivo/portfolio';
import { getTradeHistory } from '@kivo/trading/kivo/history';
import { api, socialReady } from './session';
import { getWalletSession } from './walletStore';

const pending = new Set<string>();
const sent = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  if (!pending.size || !socialReady()) return;
  const ids = [...pending].slice(0, 50);
  ids.forEach(id => { pending.delete(id); sent.add(id); });
  void api.markFeedSeen(ids).catch(() => ids.forEach(id => sent.delete(id)));
  if (pending.size) flushTimer = setTimeout(flush, 1_000);
}

/** Counts these posts as seen (the list reports them after 60% on screen for a second). */
export function markFeedPostsSeen(postIds: string[]) {
  for (const id of postIds) if (!sent.has(id)) pending.add(id);
  if (pending.size >= 20) flush();
  else if (pending.size) flushTimer ??= setTimeout(flush, 5_000);
}

let holdingsSyncedAt = 0;
/** Shares the wallet's token list with the feed ranking, at most every 10 minutes. */
export function syncFeedHoldings() {
  const wallet = getWalletSession();
  if (!wallet || !socialReady() || Date.now() - holdingsSyncedAt < 600_000) return;
  holdingsSyncedAt = Date.now();
  void fetchPortfolio(wallet.address, getTradeHistory(), { solanaAddress: wallet.solanaAddress, nearAddress: wallet.nearAddress })
    .then(portfolio => api.setFeedHoldings(portfolio.holdings
      .filter(holding => holding.kind === 'token' && holding.address)
      .slice(0, 200)
      .map(holding => ({ chain: holding.chainKey, address: holding.address }))))
    .catch(() => { holdingsSyncedAt = 0; });
}
