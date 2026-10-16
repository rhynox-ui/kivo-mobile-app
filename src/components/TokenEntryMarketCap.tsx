import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

/** Immutable entry market-cap snapshot; absolutely positioned so the token card dimensions stay unchanged. */
export function TokenEntryMarketCap({ value }: { value?: number | null }) {
  const valid = value != null && Number.isFinite(value) && value > 0;
  const amount = valid ? (value! >= 1e9 ? (value! / 1e9).toFixed(1) + 'B' : value! >= 1e6 ? (value! / 1e6).toFixed(1) + 'M' : value! >= 1e3 ? (value! / 1e3).toFixed(1) + 'K' : Math.round(value!).toLocaleString()) : '—';
  return <View pointerEvents="none" style={styles.root}><Text style={styles.label}>Entry MC</Text><Text style={styles.amount}>{valid ? '$' + amount : '—'}</Text></View>;
}
const c = kivoTheme.colors;
const styles = StyleSheet.create({ root: { position: 'absolute', right: 12, bottom: 32, alignItems: 'flex-end' }, label: { color: c.textMuted, fontSize: 11, fontWeight: '500', lineHeight: 14 }, amount: { color: c.text, fontSize: 13, fontWeight: '900', lineHeight: 16 } });
