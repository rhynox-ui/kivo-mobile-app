// Local trade history. Only trades that were actually signed and
// broadcast are ever recorded — quotes, cancellations and pre-sign
// failures never produce a history row.

import type {KeyValueStorage} from '../../shared/storage';
import type {TradeChain} from '../core/chainData';
import type {TradeSide} from './tokens';

export type TradeRecordStatus = 'success' | 'pending' | 'refunded' | 'failed';

export type TradeRecord = {
  id: string;
  wallet: string;
  createdAt: number;
  side: TradeSide;
  token: {chainKey: TradeChain; address: string; symbol: string; name: string; imageUrl: string | null};
  pay: {amount: string; symbol: string; chainKey: TradeChain};
  receive: {amount: string | null; symbol: string; chainKey: TradeChain};
  txHashes: string[];
  chainIds: number[];
  requestId: string | null;
  status: TradeRecordStatus;
  error?: string;
};

const KEY_PREFIX = 'kivo:trades:v1:';
const MAX_RECORDS = 200;

let storage: KeyValueStorage | null = null;
let wallet: string | null = null;
let records: TradeRecord[] = [];
const listeners = new Set<(value: TradeRecord[]) => void>();

function emit() {
  const snapshot = records.map(record => ({...record}));
  listeners.forEach(listener => listener(snapshot));
}

function persist() {
  if (!storage || !wallet) return;
  void Promise.resolve(storage.setItem(KEY_PREFIX + wallet, JSON.stringify(records))).catch(() => {});
}

export function configureTradeHistory(options: {storage: KeyValueStorage}) {
  storage = options.storage;
}

export async function activateTradeHistory(address: string | null) {
  wallet = address ? address.toLowerCase() : null;
  records = [];
  if (wallet && storage) {
    try {
      const raw = await storage.getItem(KEY_PREFIX + wallet);
      const parsed = raw ? (JSON.parse(raw) as TradeRecord[]) : [];
      records = Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && Array.isArray(item.txHashes) && item.txHashes.length > 0) : [];
    } catch {
      records = [];
    }
  }
  emit();
}

export function recordTrade(record: Omit<TradeRecord, 'id' | 'createdAt' | 'wallet'>): TradeRecord | null {
  if (!wallet || record.txHashes.length === 0) return null;
  const full: TradeRecord = {...record, id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), wallet};
  records = [full, ...records].slice(0, MAX_RECORDS);
  persist();
  emit();
  return full;
}

export function updateTradeStatus(id: string, status: TradeRecordStatus) {
  records = records.map(record => record.id === id ? {...record, status} : record);
  persist();
  emit();
}

export function getTradeHistory(): TradeRecord[] {
  return records.map(record => ({...record}));
}

export function subscribeToTradeHistory(listener: (value: TradeRecord[]) => void) {
  listeners.add(listener);
  listener(getTradeHistory());
  return () => { listeners.delete(listener); };
}
