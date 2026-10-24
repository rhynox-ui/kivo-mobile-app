import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { kivoTheme } from '../theme/kivoTheme';
import { TokenMarketMetrics, loadSnapshot } from './TokenMarketMetrics';
import { kivoAlert } from './KivoAlert';
import { dexScreenerChainForChain } from '@kivo/trading/core/dexScreener';

// The one token attachment card for feed posts, groups, channels and DMs,
// laid out like the web card: icon, $SYMBOL and name on the left, live MC and
// 24h change on the right; then the contract (with copy) and Entry MC in
// their own columns, so nothing overlaps on narrow chat bubbles.

export type AttachedToken = { chain: string; address: string; symbol?: string; name?: string; imageUrl?: string | null; entryMarketCapUsd?: number | null };

function compactUsd(value: number): string {
  return '$' + (value >= 1e9 ? (value / 1e9).toFixed(1) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : Math.round(value).toLocaleString());
}

export function TokenAttachmentCard({ token, onPress, compact = false }: { token: AttachedToken; onPress?: () => void; compact?: boolean }) {
  // Logo sources tried in turn when one fails to load (dead IPFS link,
  // hotlink block): the saved one, the live market one, then DexScreener's
  // logo for this contract. Only then the letter mark.
  const [logoIndex, setLogoIndex] = useState(0);
  // Live MC vs the MC when it was posted: the call's return so far.
  const [liveCap, setLiveCap] = useState<number | null>(null);
  // Cards saved without a logo use the one from the live market data.
  const [liveLogo, setLiveLogo] = useState<string | null>(null);
  useEffect(() => { let active = true; setLiveCap(null); setLiveLogo(null); void loadSnapshot(token.chain, token.address).then(value => { if (active) { setLiveCap(value.marketCapUsd); setLiveLogo(value.imageUrl ?? null); } }); return () => { active = false; }; }, [token.chain, token.address]);
  const ds = dexScreenerChainForChain(token.chain as never);
  const dexScreenerLogo = ds ? `https://dd.dexscreener.com/ds-data/tokens/${ds}/${token.chain.toLowerCase() === 'solana' ? token.address : token.address.toLowerCase()}.png` : null;
  const logos = [...new Set([token.imageUrl, liveLogo, dexScreenerLogo].filter((uri): uri is string => typeof uri === 'string' && uri.trim().length > 0))];
  const logo = logos[logoIndex];
  useEffect(() => { setLogoIndex(0); }, [token.chain, token.address, token.imageUrl]);
  const sinceCall = liveCap != null && token.entryMarketCapUsd != null && Number.isFinite(token.entryMarketCapUsd) && token.entryMarketCapUsd > 0 ? (liveCap / token.entryMarketCapUsd - 1) * 100 : null;
  const entry = token.entryMarketCapUsd != null && Number.isFinite(token.entryMarketCapUsd) && token.entryMarketCapUsd > 0 ? compactUsd(token.entryMarketCapUsd) : '—';
  const short = token.address.length > 12 ? token.address.slice(0, compact ? 5 : 7) + '…' + token.address.slice(-5) : token.address;
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={`Open ${token.symbol ? '$' + token.symbol : 'token'} in Trade`} style={({ pressed }) => [styles.card, compact && styles.compact, pressed && styles.pressed]}>
      <View style={styles.top}>
        {logo ? <Image key={logo} source={{ uri: logo }} onError={() => setLogoIndex(index => index + 1)} style={[styles.icon, compact && styles.iconCompact]} resizeMode="cover" /> : <View style={[styles.icon, compact && styles.iconCompact, styles.iconFallback]}><Text style={styles.iconGlyph}>{token.symbol ? token.symbol.slice(0, 1).toUpperCase() : '◈'}</Text></View>}
        <View style={styles.title}>
          <Text style={styles.symbol} numberOfLines={1}>{token.symbol ? '$' + token.symbol : 'Token'}</Text>
          {token.name ? <Text style={styles.name} numberOfLines={1}>{token.name}</Text> : null}
        </View>
        <TokenMarketMetrics chain={token.chain} address={token.address} stacked />
      </View>
      <View style={styles.bottom}>
        <View style={styles.contract}>
          <Text style={styles.label}>Contract</Text>
          <Text style={styles.address} numberOfLines={1}>{short}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Copy token address" hitSlop={10} onPress={() => { Clipboard.setString(token.address); kivoAlert('Token address', 'Copied to clipboard.'); }}>
            <Text style={styles.copy}>⧉</Text>
          </Pressable>
        </View>
        <View style={styles.entry}>
          <Text style={styles.label}>Entry MC</Text>
          <Text style={styles.entryValue}>{entry}</Text>
          {sinceCall != null ? <Text style={[styles.sinceCall, sinceCall >= 0 ? styles.up : styles.down]}>{sinceCall >= 0 ? '+' : '−'}{Math.abs(sinceCall).toFixed(Math.abs(sinceCall) >= 100 ? 0 : 1)}% since call</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.backgroundDeep, marginVertical: 6 },
  compact: { padding: 11, borderRadius: 14, marginVertical: 4 },
  pressed: { opacity: 0.85 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 42, height: 42, borderRadius: 21, backgroundColor: c.surface },
  iconCompact: { width: 34, height: 34, borderRadius: 17 },
  iconFallback: { alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { color: c.accent, fontSize: 18, fontWeight: '900' },
  title: { flex: 1, minWidth: 0 },
  symbol: { color: c.text, fontWeight: '900', fontSize: 15 },
  name: { color: c.textMuted, fontSize: 12, marginTop: 1 },
  bottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
  contract: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { color: c.textMuted, fontSize: 11, fontWeight: '600' },
  address: { color: c.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  copy: { color: c.accent, fontSize: 14, fontWeight: '900' },
  entry: { alignItems: 'flex-end', flexShrink: 0 },
  entryValue: { color: c.text, fontSize: 13, fontWeight: '900' },
  sinceCall: { fontSize: 11, fontWeight: '800', marginTop: 2 },
  up: { color: '#2FD67B' },
  down: { color: '#E57373' },
});
