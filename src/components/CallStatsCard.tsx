import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { CallStats, TokenCall } from '@kivo/shared/api/types';
import { kivoTheme } from '../theme/kivoTheme';

// "Calls (30 days)": tokens a person (or a community) posted in chats and the
// feed, priced from the MC when posted to the live MC. Server-computed; hidden
// until there is at least one call.

function compactUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return '$' + (value >= 1e9 ? (value / 1e9).toFixed(1) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : Math.round(value).toLocaleString());
}
export function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1) + '%';
}
const tone = (value: number | null) => value == null ? styles.muted : value >= 0 ? styles.up : styles.down;

function CallRow({ call }: { call: TokenCall }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <View style={styles.row}>
      {call.imageUrl && !logoFailed ? <Image source={{ uri: call.imageUrl }} onError={() => setLogoFailed(true)} style={styles.icon} /> : <View style={[styles.icon, styles.iconFallback]}><Text style={styles.iconGlyph}>{(call.symbol || '◈').slice(0, 1).toUpperCase()}</Text></View>}
      <View style={styles.flex}>
        <Text style={styles.symbol} numberOfLines={1}>${call.symbol}</Text>
        <Text style={styles.small} numberOfLines={1}>{compactUsd(call.entryMarketCapUsd)} → {compactUsd(call.marketCapUsd)} · {new Date(call.calledAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</Text>
      </View>
      <Text style={[styles.pct, tone(call.returnPct)]}>{formatPct(call.returnPct)}</Text>
    </View>
  );
}

/** `loadKey` changes when the subject changes; `load` fetches the stats (api.userCalls / api.communityCalls). */
export function CallStatsCard({ loadKey, load, style }: { loadKey: string; load: () => Promise<CallStats>; style?: StyleProp<ViewStyle> }) {
  const [stats, setStats] = useState<CallStats | null>(null);
  useEffect(() => { let active = true; setStats(null); load().then(value => { if (active) setStats(value); }).catch(() => {}); return () => { active = false; }; }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stats || stats.calls <= 0) return null;
  return (
    <View style={[styles.card, style]}>
      <Text style={styles.title}>Calls (30 days)</Text>
      <View style={styles.stats}>
        <View style={styles.stat}><Text style={styles.statValue}>{stats.calls}</Text><Text style={styles.statLabel}>Calls</Text></View>
        <View style={styles.stat}><Text style={[styles.statValue, tone(stats.avgReturnPct)]}>{formatPct(stats.avgReturnPct)}</Text><Text style={styles.statLabel}>Avg return</Text></View>
        <View style={styles.stat}><Text style={styles.statValue}>{stats.winRate == null ? '—' : Math.round(stats.winRate * 100) + '%'}</Text><Text style={styles.statLabel}>Win rate</Text></View>
      </View>
      {stats.best ? <><Text style={styles.label}>Best call</Text><CallRow call={stats.best} /></> : null}
      {stats.recent.length ? <><Text style={styles.label}>Recent</Text>{stats.recent.slice(0, 5).map(call => <CallRow key={call.chain + call.address + call.calledAt} call={call} />)}</> : null}
      {stats.tracked < stats.calls ? <Text style={styles.small}>{stats.tracked} of {stats.calls} calls have a live price.</Text> : null}
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 8 },
  title: { color: c.text, fontWeight: '800', fontSize: 15 },
  stats: { flexDirection: 'row', backgroundColor: c.backgroundDeep, borderRadius: 12, paddingVertical: 10 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: c.text, fontSize: 16, fontWeight: '900' },
  statLabel: { color: c.textMuted, fontSize: 11, marginTop: 2 },
  label: { color: c.textMuted, fontSize: 11.5, fontWeight: '700', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  icon: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.backgroundDeep },
  iconFallback: { alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { color: c.accent, fontWeight: '900' },
  flex: { flex: 1, minWidth: 0 },
  symbol: { color: c.text, fontWeight: '800' },
  small: { color: c.textMuted, fontSize: 11.5 },
  pct: { fontWeight: '900', fontSize: 13 },
  muted: { color: c.textMuted },
  up: { color: '#2FD67B' },
  down: { color: '#E57373' },
});
