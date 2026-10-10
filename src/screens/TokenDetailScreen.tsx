import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { fetchCandles, fetchTokenMarket, type Candle, type ChartRange, type TokenMarket } from '@kivo/trading/kivo/market';
import { chainLabel, formatPercent, formatUsd, shortAddress, tradeSupportFor, type KivoToken } from '@kivo/trading/kivo/tokens';
import { getWalletSession, walletKind } from '../state/walletStore';
import { LineChart } from '../components/LineChart';
import { MAINNET_CHAIN_IDS } from '@kivo/trading/core/chainData';
import { checkSolanaTokenSecurity, checkTokenSecurity, type TokenSecuritySummary } from '@kivo/trading/core/goplusTokenSecurity';
import { openHttpsUrl } from '../utils/openExternal';

const RANGES: ChartRange[] = ['1H', '1D', '1W', '1M'];

export function TokenDetailScreen({ token, onBuy, onSell, onBack, onMarket }: {
  token?: KivoToken | null;
  onBuy?: () => void;
  onSell?: () => void;
  onBack?: () => void;
  /** Called with fresher market data so the trade ticket uses the latest price. */
  onMarket?: (token: KivoToken) => void;
}) {
  const [market, setMarket] = useState<TokenMarket | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<ChartRange>('1D');
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [security, setSecurity] = useState<TokenSecuritySummary | null>(null);
  const [securityLoading, setSecurityLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    fetchTokenMarket(token.chainKey, token.tokenAddress).then(result => {
      if (cancelled) return;
      setMarket(result);
      setLoading(false);
      if (result) onMarket?.({ ...result.token, imageUrl: result.token.imageUrl ?? token.imageUrl });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.chainKey, token?.tokenAddress]);

  useEffect(() => {
    if (!market) return;
    let cancelled = false;
    setCandles(null);
    fetchCandles(market.token.chainKey, market.pairAddress, range).then(data => { if (!cancelled) setCandles(data); });
    return () => { cancelled = true; };
  }, [market, range]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setSecurity(null);
    setSecurityLoading(true);
    const run = token.chainKey === 'solana'
      ? checkSolanaTokenSecurity(token.tokenAddress)
      : token.chainKey === 'near'
        ? Promise.resolve(null)
        : checkTokenSecurity(MAINNET_CHAIN_IDS[token.chainKey], token.tokenAddress);
    run.then(result => { if (!cancelled) setSecurity(result); })
      .catch(() => { if (!cancelled) setSecurity(null); })
      .finally(() => { if (!cancelled) setSecurityLoading(false); });
    return () => { cancelled = true; };
  }, [token?.chainKey, token?.tokenAddress]);

  if (!token) return <View style={styles.container}><Text style={styles.muted}>Choose a token from Discover.</Text></View>;
  const live = market?.token ?? token;
  const wallet = getWalletSession();
  const support = tradeSupportFor(live, wallet ? { kind: walletKind(wallet)! } : null);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
        <Text style={styles.headerTitle}>{live.symbol}</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.identity}>
        {live.imageUrl ? <Image source={{ uri: live.imageUrl }} style={styles.icon} /> : <View style={styles.icon}><Text style={styles.letter}>{live.symbol.slice(0, 1).toUpperCase()}</Text></View>}
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>{live.name}</Text>
          <Text style={styles.muted}>{live.symbol} · {chainLabel(live.chainKey)} · {shortAddress(live.tokenAddress)}</Text>
        </View>
      </View>

      <Text style={styles.price}>{formatUsd(live.priceUsd)}</Text>
      <Text style={[styles.change, { color: (live.change24h ?? 0) >= 0 ? kivoTheme.colors.success : kivoTheme.colors.danger }]}>{formatPercent(live.change24h)} · 24h</Text>

      <View style={styles.ranges}>
        {RANGES.map(item => <Pressable key={item} onPress={() => setRange(item)} style={[styles.range, range === item && styles.rangeActive]}><Text style={[styles.rangeText, range === item && styles.rangeTextActive]}>{item}</Text></Pressable>)}
      </View>
      <View style={styles.chart}>
        {loading || (market && candles == null) ? <ActivityIndicator color={kivoTheme.colors.accent} />
          : candles && candles.length > 1 ? <LineChart values={candles.map(c => c.close)} />
          : <Text style={styles.muted}>No price history available for this pool and range.</Text>}
      </View>

      {!loading && !market && <Text style={styles.muted}>No active market was found for this token on {chainLabel(token.chainKey)}.</Text>}
      {market && (
        <View style={styles.card}>
          <Stat label="Market cap" value={formatUsd(live.marketCapUsd, { compact: true })} />
          <Stat label="Liquidity" value={formatUsd(live.liquidityUsd, { compact: true })} />
          <Stat label="24h volume" value={formatUsd(market.volumeUsd24h, { compact: true })} />
          <Stat label="24h trades" value={market.buys24h == null ? '—' : `${market.buys24h} buys · ${market.sells24h ?? 0} sells`} />
          <Stat label="Pool" value={`${market.dexId ?? 'DEX'} · ${shortAddress(market.pairAddress)}`} />
          <View style={styles.links}>
            {market.socialLinks.map(link => <Pressable key={link.url} onPress={() => openHttpsUrl(link.url)}><Text style={styles.link}>{link.kind === 'x' ? 'X' : link.kind === 'telegram' ? 'Telegram' : 'Website'}</Text></Pressable>)}
            <Pressable onPress={() => openHttpsUrl(market.dexScreenerUrl)}><Text style={styles.link}>DexScreener</Text></Pressable>
          </View>
        </View>
      )}

      <View style={styles.securityCard}>
        <View style={styles.securityHead}>
          <Text style={styles.securityTitle}>Token security</Text>
          <Text style={securityLoading ? styles.securityChecking : security?.isHoneypot ? styles.securityDanger : security ? styles.securityOk : styles.securityUnknown}>
            {securityLoading ? 'Checking…' : security?.isHoneypot ? 'High risk' : security ? (security.flags.length ? 'Review' : 'No flags') : 'Unavailable'}
          </Text>
        </View>
        {security?.isHoneypot && <Text style={styles.securityDangerText}>GoPlus flags this token as a possible honeypot. Kivo will not start a buy from this screen.</Text>}
        {security?.flags.length ? security.flags.slice(0, 4).map(flag => <Text key={flag} style={styles.securityFlag}>• {flag}</Text>) : null}
        {security && (security.buyTaxPercent != null || security.sellTaxPercent != null) && (
          <Text style={styles.securityMeta}>
            {security.buyTaxPercent != null ? `Buy tax ${security.buyTaxPercent.toFixed(2)}%` : ''}
            {security.buyTaxPercent != null && security.sellTaxPercent != null ? ' · ' : ''}
            {security.sellTaxPercent != null ? `Sell tax ${security.sellTaxPercent.toFixed(2)}%` : ''}
          </Text>
        )}
        {!securityLoading && !security && <Text style={styles.muted}>No live GoPlus result was available. This is not a safety confirmation.</Text>}
      </View>

      {support.ok ? (
        <View style={styles.actions}>
          <Pressable disabled={security?.isHoneypot === true} onPress={onBuy} style={[styles.buy, security?.isHoneypot === true && styles.disabled]}><Text style={styles.buyText}>{security?.isHoneypot ? 'Buy blocked' : 'Buy'}</Text></Pressable>
          <Pressable onPress={onSell} style={styles.sell}><Text style={styles.sellText}>Sell</Text></Pressable>
        </View>
      ) : <View style={styles.notice}><Text style={styles.muted}>{support.reason}</Text></View>}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.muted}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  header: { height: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { color: c.cream, fontSize: 34 },
  headerTitle: { color: c.text, fontWeight: '700', fontSize: 17 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  icon: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  letter: { color: c.cream, fontSize: 20, fontWeight: '800' },
  flex: { flex: 1 },
  name: { color: c.text, fontSize: 18, fontWeight: '800' },
  muted: { color: c.textMuted, fontSize: 12, lineHeight: 18 },
  price: { color: c.cream, fontSize: 34, fontWeight: '800', marginTop: 20 },
  change: { fontSize: 13, marginTop: 2, fontWeight: '700' },
  ranges: { flexDirection: 'row', gap: 6, marginTop: 16 },
  range: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: c.surface },
  rangeActive: { backgroundColor: c.cream },
  rangeText: { color: c.textMuted, fontWeight: '800', fontSize: 12 },
  rangeTextActive: { color: c.backgroundDeep },
  chart: { height: 210, marginTop: 12, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 20 },
  card: { marginTop: 16, padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  stat: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  statValue: { color: c.text, fontWeight: '700', fontSize: 12.5 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 },
  link: { color: c.accent, fontWeight: '800', fontSize: 12.5 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  buy: { flex: 1, height: 56, borderRadius: 28, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  buyText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 16 },
  sell: { flex: 1, height: 56, borderRadius: 28, borderWidth: 1.5, borderColor: '#FF6B6B', alignItems: 'center', justifyContent: 'center' },
  sellText: { color: '#FF6B6B', fontWeight: '900', fontSize: 16 },
  notice: { marginTop: 20, padding: 14, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  securityCard: { marginTop: 16, padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  securityHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  securityTitle: { color: c.text, fontWeight: '800', fontSize: 15 },
  securityChecking: { color: c.textMuted, fontSize: 12, fontWeight: '800' },
  securityOk: { color: c.success, fontSize: 12, fontWeight: '800' },
  securityUnknown: { color: c.textMuted, fontSize: 12, fontWeight: '800' },
  securityDanger: { color: c.danger, fontSize: 12, fontWeight: '900' },
  securityDangerText: { color: c.danger, fontSize: 12.5, lineHeight: 18, marginTop: 8, fontWeight: '700' },
  securityFlag: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  securityMeta: { color: c.textMuted, fontSize: 11.5, marginTop: 8 },
  disabled: { opacity: 0.45 },
});
