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
  void loadTransfers();
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

// Sends and withdrawals (wallet-to-wallet transfers). Kept apart from trades
// so they never feed cost basis, PnL or trade counts. Only transfers that were
// signed and may have reached the network are recorded.

export type TransferRecord = {
  id: string;
  wallet: string;
  createdAt: number;
  kind: 'send' | 'withdraw';
  chainKey: string;
  /** EVM chain id for explorer links; null for Solana/NEAR. */
  chainId: number | null;
  symbol: string;
  amount: string;
  to: string;
  /** "@username" when sent to a Kivo user. */
  toLabel?: string;
  txHash: string | null;
  requestId: string | null;
  status: TradeRecordStatus;
  error?: string;
};

const TRANSFER_KEY_PREFIX = 'kivo:transfers:v1:';
let transfers: TransferRecord[] = [];
const transferListeners = new Set<(value: TransferRecord[]) => void>();

function emitTransfers() {
  const snapshot = transfers.map(record => ({...record}));
  transferListeners.forEach(listener => listener(snapshot));
}

function persistTransfers() {
  if (!storage || !wallet) return;
  void Promise.resolve(storage.setItem(TRANSFER_KEY_PREFIX + wallet, JSON.stringify(transfers))).catch(() => {});
}

async function loadTransfers() {
  const owner = wallet;
  transfers = [];
  if (owner && storage) {
    try {
      const raw = await storage.getItem(TRANSFER_KEY_PREFIX + owner);
      const parsed = raw ? (JSON.parse(raw) as TransferRecord[]) : [];
      if (wallet !== owner) return;
      transfers = Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && (item.txHash || item.requestId)) : [];
    } catch {
      transfers = [];
    }
  }
  emitTransfers();
}

export function recordTransfer(record: Omit<TransferRecord, 'id' | 'createdAt' | 'wallet'>): TransferRecord | null {
  if (!wallet || (!record.txHash && !record.requestId)) return null;
  const full: TransferRecord = {...record, id: `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), wallet};
  transfers = [full, ...transfers].slice(0, MAX_RECORDS);
  persistTransfers();
  emitTransfers();
  return full;
}

export function updateTransferStatus(id: string, status: TradeRecordStatus) {
  transfers = transfers.map(record => record.id === id ? {...record, status} : record);
  persistTransfers();
  emitTransfers();
}

export function getTransferHistory(): TransferRecord[] {
  return transfers.map(record => ({...record}));
}

export function subscribeToTransferHistory(listener: (value: TransferRecord[]) => void) {
  transferListeners.add(listener);
  listener(getTransferHistory());
  return () => { transferListeners.delete(listener); };
}
