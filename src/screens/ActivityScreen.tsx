import React, { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { explorerTxUrl, fetchRelayStatus, relayRequestUrl } from '@kivo/trading/kivo/execute';
import { subscribeToTradeHistory, updateTradeStatus, type TradeRecord } from '@kivo/trading/kivo/history';
import { formatAmount, shortAddress } from '@kivo/trading/kivo/tokens';

/** Trades this wallet actually signed — same shared history model as Kivo web. */
export function ActivityScreen({ onBack }: { onBack: () => void }) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  useEffect(() => subscribeToTradeHistory(setTrades), []);
  const refresh = async (trade: TradeRecord) => {
    if (!trade.requestId) return;
    const status = await fetchRelayStatus(trade.requestId);
    if (status === 'success') updateTradeStatus(trade.id, 'success');
    else if (status === 'refund') updateTradeStatus(trade.id, 'refunded');
    else if (status === 'failure') updateTradeStatus(trade.id, 'failed');
  };
  return (
    <View style={styles.root}>
      <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.title}>Activity</Text></View>
      <ScrollView contentContainerStyle={styles.body}>
        {trades.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>No trades yet</Text><Text style={styles.emptyText}>Only trades you sign and broadcast are recorded. Quotes never are.</Text></View> : trades.map(trade => (
          <View key={trade.id} style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.name}>{trade.side === 'buy' ? 'Buy' : 'Sell'} {trade.token.symbol}</Text>
              <Text style={[styles.status, trade.status === 'success' ? styles.ok : trade.status === 'failed' ? styles.bad : styles.pending]}>{trade.status}</Text>
            </View>
            <Text style={styles.muted}>{trade.pay.amount} {trade.pay.symbol} → {trade.receive.amount ? formatAmount(Number(trade.receive.amount)) : '—'} {trade.receive.symbol} · {new Date(trade.createdAt).toLocaleString()}</Text>
            {trade.txHashes.map((hash, index) => {
              const url = explorerTxUrl(trade.chainIds[index] ?? trade.chainIds[0] ?? 0, hash);
              return <Pressable key={hash} disabled={!url} onPress={() => url && Linking.openURL(url)}><Text style={styles.link}>{shortAddress(hash, 10, 6)}</Text></Pressable>;
            })}
            {trade.requestId && <View style={styles.row}>
              <Pressable onPress={() => Linking.openURL(relayRequestUrl(trade.requestId!))}><Text style={styles.link}>Route status</Text></Pressable>
              {trade.status === 'pending' && <Pressable onPress={() => refresh(trade)}><Text style={styles.link}>Check now</Text></Pressable>}
            </View>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 64, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  back: { color: c.cream, fontSize: 36 },
  title: { color: c.text, fontSize: 22, fontWeight: '800' },
  body: { padding: 18, gap: 10, flexGrow: 1 },
  empty: { flex: 1, minHeight: 420, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptyText: { color: c.textMuted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  card: { padding: 14, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { color: c.text, fontWeight: '800', fontSize: 15 },
  muted: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
  link: { color: c.accent, fontWeight: '700', fontSize: 12 },
  status: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  ok: { color: c.success },
  bad: { color: c.danger },
  pending: { color: '#F2C96D' },
});
