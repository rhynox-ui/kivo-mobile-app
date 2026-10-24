import React, {useEffect, useMemo, useState} from 'react';
import {FlatList, Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {kivoTheme} from '../theme/kivoTheme';
import {fetchRelayStatus, relayRequestUrl, transactionLink} from '@kivo/trading/kivo/execute';
import {MAINNET_CHAIN_IDS, type ChainKey} from '@kivo/trading/core/chainData';
import {subscribeToTradeHistory, subscribeToTransferHistory, updateTradeStatus, updateTransferStatus, type TradeRecord, type TransferRecord} from '@kivo/trading/kivo/history';
import {checkTransferStatus} from '@kivo/trading/kivo/transferStatus';

type ActivityItem = {type: 'trade'; id: string; createdAt: number; trade: TradeRecord} | {type: 'transfer'; id: string; createdAt: number; transfer: TransferRecord};
import {formatAmount, shortAddress} from '@kivo/trading/kivo/tokens';

export function ActivityScreen({onBack}: {onBack: () => void}) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  useEffect(() => subscribeToTradeHistory(setTrades), []);
  useEffect(() => subscribeToTransferHistory(setTransfers), []);
  const items = useMemo<ActivityItem[]>(() => [
    ...trades.map(trade => ({type: 'trade' as const, id: trade.id, createdAt: trade.createdAt, trade})),
    ...transfers.map(transfer => ({type: 'transfer' as const, id: transfer.id, createdAt: transfer.createdAt, transfer})),
  ].sort((a, b) => b.createdAt - a.createdAt), [trades, transfers]);

  const refreshTransfer = async (transfer: TransferRecord) => {
    if (refreshing) return;
    setRefreshing(transfer.id);
    try {
      const status = await checkTransferStatus({txHash: transfer.txHash, requestId: transfer.requestId, chainId: transfer.chainId});
      if (status === 'confirmed') updateTransferStatus(transfer.id, 'success');
      else if (status === 'failed') updateTransferStatus(transfer.id, 'failed');
    } finally {
      setRefreshing(null);
    }
  };

  const renderTransfer = (transfer: TransferRecord) => {
    const url = transfer.txHash ? transactionLink(transfer.txHash, transfer.chainId) : null;
    return (
      <View style={styles.item}>
        <View style={[styles.dot, transfer.status !== 'success' && styles.dotPending]} />
        <View style={styles.main}>
          <View style={styles.top}>
            <Text style={styles.rowTitle}>{transfer.kind === 'withdraw' ? 'Withdrew' : 'Sent'} {transfer.symbol}</Text>
            <Text style={[styles.status, transfer.status === 'success' ? styles.ok : transfer.status === 'failed' ? styles.bad : transfer.status === 'refunded' ? styles.refunded : styles.pending]}>{transfer.status}</Text>
          </View>
          <Text style={styles.subtitle} numberOfLines={1}>{transfer.amount} {transfer.symbol} → {transfer.toLabel ?? shortAddress(transfer.to)}</Text>
          <Text style={styles.when}>{new Date(transfer.createdAt).toLocaleString()}</Text>
          {url && transfer.txHash ? <Pressable hitSlop={8} onPress={() => { Linking.openURL(url).catch(() => {}); }}><Text style={styles.link}>{shortAddress(transfer.txHash, 10, 6)}  ↗</Text></Pressable> : null}
          <View style={styles.actions}>
            {transfer.requestId ? <Pressable onPress={() => Linking.openURL(relayRequestUrl(transfer.requestId!))}><Text style={styles.link}>Route status</Text></Pressable> : null}
            {transfer.status === 'pending' ? <Pressable onPress={() => refreshTransfer(transfer)} disabled={refreshing === transfer.id}><Text style={styles.link}>{refreshing === transfer.id ? 'Checking…' : 'Check now'}</Text></Pressable> : null}
          </View>
          {transfer.error && transfer.status === 'pending' ? <Text style={styles.error}>{transfer.error}</Text> : null}
        </View>
      </View>
    );
  };

  const refresh = async (trade: TradeRecord) => {
    if (!trade.requestId || refreshing) return;
    setRefreshing(trade.id);
    try {
      const status = await fetchRelayStatus(trade.requestId);
      if (status === 'success') updateTradeStatus(trade.id, 'success');
      else if (status === 'refund') updateTradeStatus(trade.id, 'refunded');
      else if (status === 'failure') updateTradeStatus(trade.id, 'failed');
    } finally {
      setRefreshing(null);
    }
  };

  const renderItem = ({item}: {item: ActivityItem}) => item.type === 'transfer' ? renderTransfer(item.transfer) : renderTrade(item.trade);

  const renderTrade = (trade: TradeRecord) => (
    <View style={styles.item}>
      <View style={[styles.dot, trade.status !== 'success' && styles.dotPending]} />
      <View style={styles.main}>
        <View style={styles.top}>
          <Text style={styles.rowTitle}>{trade.side === 'buy' ? 'Bought' : 'Sold'} {trade.token.symbol}</Text>
          <Text style={[styles.status, trade.status === 'success' ? styles.ok : trade.status === 'failed' ? styles.bad : trade.status === 'refunded' ? styles.refunded : styles.pending]}>{trade.status}</Text>
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>{trade.pay.amount} {trade.pay.symbol} → {trade.receive.amount ? formatAmount(Number(trade.receive.amount)) : '—'} {trade.receive.symbol}</Text>
        <Text style={styles.when}>{new Date(trade.createdAt).toLocaleString()}</Text>
        {trade.txHashes.map((hash, index) => {
          const url = transactionLink(hash, trade.chainIds[index] ?? trade.chainIds[0], MAINNET_CHAIN_IDS[trade.token.chainKey as ChainKey]);
          return (
            <Pressable key={hash} hitSlop={8} onPress={() => { Linking.openURL(url).catch(() => {}); }}>
              <Text style={styles.link}>{trade.txHashes.length > 1 ? `Transaction ${index + 1}: ` : ''}{shortAddress(hash, 10, 6)}  ↗</Text>
            </Pressable>
          );
        })}
        {trade.requestId && <View style={styles.actions}>
          <Pressable onPress={() => Linking.openURL(relayRequestUrl(trade.requestId!))}>
            <Text style={styles.link}>Route status</Text>
          </Pressable>
          {trade.status === 'pending' && <Pressable onPress={() => refresh(trade)} disabled={refreshing === trade.id}>
            <Text style={styles.link}>{refreshing === trade.id ? 'Checking…' : 'Check now'}</Text>
          </Pressable>}
        </View>}
        {trade.error ? <Text style={styles.error}>{trade.error}</Text> : null}
      </View>
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
        <Text style={styles.title}>History</Text>
      </View>
      <FlatList
        style={styles.list}
        data={items}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.body, items.length === 0 && styles.emptyBody]}
        showsVerticalScrollIndicator={false}
        windowSize={7}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        removeClippedSubviews
        ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyText}>No activity yet — your trades, sends and withdrawals will show up here.</Text></View>}
      />
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: c.background, paddingHorizontal: 16},
  list: {flex: 1},
  header: {paddingTop: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8},
  back: {color: c.textMuted, fontSize: 34, lineHeight: 34},
  title: {color: c.text, fontSize: 30, fontWeight: '800'},
  body: {paddingBottom: 32},
  emptyBody: {flexGrow: 1},
  item: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: c.success, marginTop: 6},
  dotPending: {backgroundColor: '#F2C96D'},
  main: {flex: 1, minWidth: 0},
  top: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  rowTitle: {color: c.text, fontSize: 13.5, fontWeight: '800', flex: 1},
  status: {fontSize: 9.5, fontWeight: '800', textTransform: 'uppercase'},
  ok: {color: c.success}, bad: {color: c.danger}, refunded: {color: '#F2C96D'}, pending: {color: c.textMuted},
  subtitle: {color: c.textMuted, fontSize: 11.5, marginTop: 3},
  when: {color: c.textMuted, fontSize: 10.5, marginTop: 2},
  actions: {flexDirection: 'row', gap: 18},
  link: {color: c.accent, fontSize: 11.5, fontWeight: '700', marginTop: 7},
  error: {color: c.danger, fontSize: 11, marginTop: 7},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  emptyText: {color: c.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19},
});
