import AsyncStorage from '@react-native-async-storage/async-storage';
import {addNotification} from '../state/notificationStore';

// Notices USDC arriving in the Kivo wallet. Balances are compared per
// network, so one network that doesn't answer never blocks a notification
// for another (before, any unread network meant no notification at all).
// Moves the user makes themselves (trades, Convert, withdrawals) are not
// deposits: increases within OWN_ACTION_WINDOW_MS of one are ignored.
const PREFIX = 'kivo:deposit-watch:v2:';
const EPSILON_USD = 0.01;
const OWN_ACTION_WINDOW_MS = 10 * 60 * 1000;
type State = {balances: Record<string, number>; lastOwnActionAt: number};

async function load(address: string): Promise<State | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + address.toLowerCase());
    if (!raw) return null;
    const x = JSON.parse(raw);
    if (!x || typeof x.balances !== 'object') return null;
    return {balances: x.balances, lastOwnActionAt: typeof x.lastOwnActionAt === 'number' ? x.lastOwnActionAt : 0};
  } catch {
    return null;
  }
}

async function save(address: string, state: State) {
  await AsyncStorage.setItem(PREFIX + address.toLowerCase(), JSON.stringify(state));
}

/** Milliseconds since the user's last own cash move (trade, Convert, withdrawal), or Infinity. */
export async function msSinceOwnAction(address: string): Promise<number> {
  const x = await load(address);
  return x?.lastOwnActionAt ? Date.now() - x.lastOwnActionAt : Number.POSITIVE_INFINITY;
}

export async function markOwnAction(address: string) {
  const x = await load(address);
  await save(address, {balances: x?.balances ?? {}, lastOwnActionAt: Date.now()});
}

/**
 * `readings` holds only networks that answered (network label -> USDC amount).
 * Returns the total newly received, or null when nothing new arrived.
 */
export async function checkForDeposits(address: string, readings: Record<string, number>): Promise<number | null> {
  const previous = await load(address);
  const balances = {...(previous?.balances ?? {}), ...readings};
  await save(address, {balances, lastOwnActionAt: previous?.lastOwnActionAt ?? 0});
  // First reading of a network is a baseline, never a "deposit".
  if (!previous) return null;
  if (Date.now() - previous.lastOwnActionAt < OWN_ACTION_WINDOW_MS) return null;
  const arrivals = Object.entries(readings)
    .map(([network, amount]) => ({network, delta: network in previous.balances ? amount - previous.balances[network] : 0}))
    .filter(item => item.delta > EPSILON_USD);
  if (!arrivals.length) return null;
  const total = arrivals.reduce((sum, item) => sum + item.delta, 0);
  const where = arrivals.length === 1 ? ` on ${arrivals[0].network}` : '';
  await addNotification('Deposit received', `$${total.toFixed(2)} USDC landed in your Kivo wallet${where}.`);
  return total;
}
