// src/wallet/oneClickSwapStore.ts
//
// On-device store for NEAR Intents (1Click) swaps — the OneClickSwapStore
// that src/core/oneClickDeposits.ts writes to. Same AsyncStorage shape as
// txHistory.ts. Each record keeps the full signed quote, which 1Click
// asks integrators to hold on to for resolving disputes, so records are
// never trimmed while a swap is still unfinished.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {shouldPollOneClickSwap, type OneClickSwapRecord, type OneClickSwapStore} from '../core/oneClickDeposits.ts';

const STORAGE_KEY = 'kivo_oneclick_swaps_v1';
const MAX_FINISHED_RECORDS = 100;

let records: OneClickSwapRecord[] = [];
const listeners = new Set<(records: OneClickSwapRecord[]) => void>();

const hydrated: Promise<void> = AsyncStorage.getItem(STORAGE_KEY)
  .then(raw => {
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) records = parsed;
  })
  .catch(() => {});

function notify(): void {
  for (const listener of listeners) listener(records);
}

async function persist(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export const oneClickSwapStore: OneClickSwapStore = {
  async get(depositAddress) {
    await hydrated;
    return records.find(r => r.depositAddress === depositAddress) ?? null;
  },
  async put(record) {
    await hydrated;
    const others = records.filter(r => r.depositAddress !== record.depositAddress);
    const next = [record, ...others].sort((a, b) => b.createdAt - a.createdAt);
    // Only finished swaps are ever dropped, oldest first.
    const unfinished = next.filter(r => shouldPollOneClickSwap(r));
    const finished = next.filter(r => !shouldPollOneClickSwap(r)).slice(0, MAX_FINISHED_RECORDS);
    records = [...unfinished, ...finished].sort((a, b) => b.createdAt - a.createdAt);
    // Awaited, unlike txHistory.ts: fundOneClickQuote relies on the record
    // being on disk before it broadcasts the deposit.
    await persist();
    notify();
  },
};

export async function listOneClickSwaps(): Promise<OneClickSwapRecord[]> {
  await hydrated;
  return records;
}

export function subscribeOneClickSwaps(listener: (records: OneClickSwapRecord[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
