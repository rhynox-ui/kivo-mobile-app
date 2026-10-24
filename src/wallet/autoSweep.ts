// Runs Kivo's automatic "move home" of USDC (trading/kivo/sweep.ts) for the
// device wallet: after a deposit lands on another network, and right
// before a buy that needs those funds. Never prompts: it only runs while
// the wallet is already unlocked in this session.

import {isFeeExemptWallet} from '@kivo/trading/core/fees';
import {clearCashBalanceCache} from '@kivo/trading/kivo/balances';
import {clearSpendableBalanceCache, fetchTradeCash} from '@kivo/trading/kivo/spendable';
import {sweepCandidates, sweepToHome, type SweepResult} from '@kivo/trading/kivo/sweep';
import {formatBalanceUsd} from '@kivo/trading/kivo/tokens';
import {getWalletSession, walletUnlockedOnDevice, withDeviceAccounts} from '../state/walletStore';
import {addNotification} from '../state/notificationStore';
import {markOwnAction} from './depositWatcher';

const BACKGROUND_EVERY_MS = 5 * 60_000;
let running: Promise<SweepResult | null> | null = null;
let lastBackgroundAt = 0;

/**
 * Moves funds parked outside USDC on Solana home. `upToUsd` stops once that
 * much has moved (a buy only needs its shortfall); `background` runs are
 * throttled. Returns null when there was nothing to do or it could not run.
 */
export function runAutoSweep({upToUsd, background = false}: {upToUsd?: number; background?: boolean} = {}): Promise<SweepResult | null> {
  if (running) return running;
  if (background && Date.now() - lastBackgroundAt < BACKGROUND_EVERY_MS) return Promise.resolve(null);
  const wallet = getWalletSession();
  if (!wallet || wallet.source !== 'local' || !wallet.solanaAddress || !walletUnlockedOnDevice()) return Promise.resolve(null);
  // Kivo's own fee wallets: their collected fees are not moved in the
  // background, only when the owner's own buy needs that USDC (USDC only;
  // their SOL/ETH float is never touched by a move home).
  if (background && (isFeeExemptWallet(wallet.address) || isFeeExemptWallet(wallet.solanaAddress))) return Promise.resolve(null);
  if (background) lastBackgroundAt = Date.now();
  running = (async () => {
    try {
      const balance = await fetchTradeCash(wallet.address, wallet.solanaAddress, {forceFresh: true});
      if (!sweepCandidates(balance).length) return null;
      void markOwnAction(wallet.address).catch(() => {});
      const result = await withDeviceAccounts('Move funds to Solana', accounts => sweepToHome({balance, accounts: accounts.relay, onlyUpToUsd: upToUsd}));
      if (result.movedUsd > 0) addNotification('Balance updated', `Moved ${formatBalanceUsd(result.movedUsd)} to your USDC on Solana.`);
      return result;
    } catch {
      return null;
    } finally {
      clearCashBalanceCache();
      clearSpendableBalanceCache();
      running = null;
    }
  })();
  return running;
}
