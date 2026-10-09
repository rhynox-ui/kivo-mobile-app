import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'kivo_unlock_attempts_v1';
const FREE = 5;
const DUR = [30000, 60000, 120000, 300000, 900000];

type State = {failCount: number; lockedUntil: number};

async function load(): Promise<State> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {failCount: 0, lockedUntil: 0};
    const parsed = JSON.parse(raw);
    return {
      failCount: Number.isSafeInteger(parsed.failCount) && parsed.failCount >= 0 ? parsed.failCount : 0,
      lockedUntil: Number.isFinite(parsed.lockedUntil) && parsed.lockedUntil >= 0 ? parsed.lockedUntil : 0,
    };
  } catch {
    return {failCount: 0, lockedUntil: 0};
  }
}

async function save(state: State): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Callers still receive a lockout result; storage failure is handled as a
    // best-effort persistence limitation rather than crashing the unlock UI.
  }
}

// Serialize state transitions so rapid/concurrent failed unlock attempts cannot
// overwrite each other's counters with stale AsyncStorage reads.
let mutationQueue: Promise<void> = Promise.resolve();

function mutate<T>(work: () => Promise<T>): Promise<T> {
  const task = mutationQueue.then(work, work);
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function getLockoutStatus() {
  await mutationQueue;
  const state = await load();
  const left = state.lockedUntil - Date.now();
  return {locked: left > 0, remainingMs: Math.max(0, left)};
}

export function recordFailedAttempt() {
  return mutate(async () => {
    const state = await load();
    const failCount = state.failCount + 1;
    let lockedUntil = state.lockedUntil;
    if (lockedUntil <= Date.now() && failCount > FREE) {
      lockedUntil = Date.now() + DUR[Math.min(failCount - FREE - 1, DUR.length - 1)];
    }
    await save({failCount, lockedUntil});
    return {locked: lockedUntil > Date.now(), remainingMs: Math.max(0, lockedUntil - Date.now())};
  });
}

export function recordSuccessfulUnlock() {
  return mutate(async () => {
    await save({failCount: 0, lockedUntil: 0});
  });
}
