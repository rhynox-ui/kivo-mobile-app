import {parseUnits} from 'viem';
import {TOKEN_ADDRESSES, assetDecimalsForChain, currencyAddress, type ChainKey} from '@kivo/trading/core/chainData';
import {getRelayQuote, type GetRelayQuoteParams} from '@kivo/trading/core/relayQuote';
import {executeRelayQuote} from '@kivo/trading/core/executeRelayQuote';
import {cashAssetSymbol, spendableCash, type CashBalanceRow} from '@kivo/trading/kivo/balances';
import {getWalletSession, isWalletUnlocked, withDeviceAccounts} from '../state/walletStore';
import {markOwnAction, msSinceOwnAction} from './depositWatcher';

// Base is Kivo's home network for cash, as Relay's Unified Balance guide
// recommends: USDC that lands on another EVM network is moved to the user's
// own USDC on Base, with the fees paid by Kivo (the server checks and caps
// it). Solana USDC stays where it is: Solana buys from it are same-network.
// Runs only while the wallet is unlocked (no fingerprint prompt out of the
// blue), never right after the user's own move, one network at a time.
// Silent by design: nothing is shown to the user; the balance just stays usable.

export const HOME_CHAIN: ChainKey = 'base';
const MIN_MOVE_USD = 0.5;
const QUIET_AFTER_OWN_ACTION_MS = 3 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** Skip a move that would lose more than this share (Kivo should be paying the fees). */
const MAX_LOSS_SHARE = 0.1;

let running = false;
const lastAttempt = new Map<ChainKey, number>();

function movable(row: CashBalanceRow): {chainKey: ChainKey; amount: number} | null {
  if (row.status !== 'ok') return null;
  const chainKey = row.chainKey;
  if (chainKey === HOME_CHAIN || chainKey === 'solana') return null;
  if (cashAssetSymbol(chainKey) !== 'USDC' || !TOKEN_ADDRESSES.USDC?.[chainKey]) return null;
  const amount = Math.floor(spendableCash(chainKey, row.balance.amount) * 1e6) / 1e6;
  if (amount < MIN_MOVE_USD) return null;
  const tried = lastAttempt.get(chainKey);
  if (tried && Date.now() - tried < RETRY_AFTER_FAILURE_MS) return null;
  return {chainKey, amount};
}

/** Moves one network's USDC to Base if it qualifies. Returns the dollars moved, or null. */
export async function autoMoveCashToBase(rows: CashBalanceRow[]): Promise<number | null> {
  if (running || !isWalletUnlocked()) return null;
  const wallet = getWalletSession();
  if (!wallet || wallet.source !== 'local') return null;
  const candidate = rows.map(movable).find((x): x is {chainKey: ChainKey; amount: number} => x !== null);
  if (!candidate) return null;
  if ((await msSinceOwnAction(wallet.address)) < QUIET_AFTER_OWN_ACTION_MS) return null;
  running = true;
  lastAttempt.set(candidate.chainKey, Date.now());
  try {
    const decimals = assetDecimalsForChain(candidate.chainKey, 'USDC') ?? 6;
    const params: GetRelayQuoteParams = {
      fromChainKey: candidate.chainKey,
      toChainKey: HOME_CHAIN,
      originCurrency: currencyAddress(candidate.chainKey, 'USDC'),
      destinationCurrency: currencyAddress(HOME_CHAIN, 'USDC'),
      amountBaseUnits: parseUnits(candidate.amount.toFixed(6), decimals).toString(),
      userAddress: wallet.address,
      recipientAddress: wallet.address,
      originAmountUsd: candidate.amount,
      // Gasless EVM route: Kivo's server records the order so its /execute sponsors the origin gas.
      originGasOverhead: '80000',
      fundingTransfer: true,
    };
    const quote = await getRelayQuote(params);
    const received = Number(quote?.details?.currencyOut?.amountUsd ?? quote?.details?.currencyOut?.amountFormatted);
    // Kivo is meant to pay the fees; if the quote would still cost the user
    // a real share (sponsorship refused or capped), leave the money alone.
    if (!(received > 0) || received < candidate.amount * (1 - MAX_LOSS_SHARE)) return null;
    await withDeviceAccounts('Move cash to Base', session =>
      executeRelayQuote(quote, session.relay, () => {}, {useGaslessTrading: true, requote: () => getRelayQuote(params)}));
    await markOwnAction(wallet.address).catch(() => {});
    lastAttempt.delete(candidate.chainKey);
    return candidate.amount;
  } catch {
    // Quiet by design: the money stays where it is and is retried later.
    return null;
  } finally {
    running = false;
  }
}
