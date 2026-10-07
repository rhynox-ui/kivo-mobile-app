import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { MAINNET_CHAIN_IDS } from '@kivo/trading/core/chainData';
import { dexScreenerEmbedUrl, resolveDexScreenerPair, type ResolvedPair } from '@kivo/trading/core/dexScreener';
import { checkSolanaTokenSecurity, checkTokenSecurity, type TokenSecuritySummary } from '@kivo/trading/core/goplusTokenSecurity';
import type { KivoToken } from '@kivo/trading/kivo/tokens';
import { kivoTheme } from '../theme/kivoTheme';

const CHART_BG = '#071614';

function compact(value: number) {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/**
 * DexScreener chart, token socials and GoPlus holder/risk data for the trade
 * screen. The embed is a third-party page inside Kivo's own chrome, so it may
 * only navigate within dexscreener.com.
 */
export function TokenChartPanel({ token }: { token: KivoToken }) {
  const [pair, setPair] = useState<ResolvedPair | null>(null);
  const [resolving, setResolving] = useState(true);
  const [security, setSecurity] = useState<TokenSecuritySummary | null>(null);
  const [holdersOpen, setHoldersOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPair(null); setResolving(true); setSecurity(null);
    resolveDexScreenerPair({ chainKey: token.chainKey, tokenAddress: token.tokenAddress })
      .then(result => { if (!cancelled) setPair(result); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setResolving(false); });
    const lookup = token.chainKey === 'solana' ? checkSolanaTokenSecurity(token.tokenAddress) : checkTokenSecurity((MAINNET_CHAIN_IDS as Partial<Record<string, number>>)[token.chainKey], token.tokenAddress);
    lookup.then(result => { if (!cancelled) setSecurity(result); }).catch(() => {});
    return () => { cancelled = true; };
  }, [token.chainKey, token.tokenAddress]);

  const embedUrl = pair ? dexScreenerEmbedUrl({ chainId: pair.chainId, pairAddress: pair.pairAddress, theme: 'dark' }) : null;
  const holders = security?.holders ?? null;
  const holderCount = security?.holderCount ?? null;
  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest) => /^https:\/\/([a-z0-9-]+\.)*dexscreener\.com\//i.test(request.url);

  return (
    <View>
      <View style={styles.row}>
        <View style={styles.socials}>
          {(pair?.socialLinks ?? []).map(link => (
            <Pressable key={link.url} onPress={() => Linking.openURL(link.url)} style={styles.iconButton} accessibilityLabel={link.kind}>
              <Text style={styles.iconText}>{link.kind === 'x' ? '𝕏' : link.kind === 'telegram' ? '✈' : '🌐'}</Text>
            </Pressable>
          ))}
        </View>
        {security?.isHoneypot ? <Text style={[styles.flag, styles.flagDanger]}>⚠ Honeypot risk</Text>
          : security?.flags.length ? <Text style={styles.flag}>⚠ {security.flags.length} risk flag{security.flags.length === 1 ? '' : 's'}</Text> : null}
        {(holderCount != null || (holders?.length ?? 0) > 0) && (
          <Pressable onPress={() => setHoldersOpen(true)} style={styles.pill}>
            <Text style={styles.pillText}>{holderCount != null ? `Holders ${compact(holderCount)}` : 'Top holders'} ▾</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.chart}>
        {resolving ? <ActivityIndicator color={kivoTheme.colors.accent} style={styles.centered} />
          : !embedUrl ? <Text style={styles.muted}>DexScreener hasn't indexed a pair for this token on this network yet.</Text>
          : (
            // Keyed on the URL: Android treats `source` as the initial URL only.
            <WebView
              key={embedUrl}
              source={{ uri: embedUrl }}
              style={styles.webview}
              originWhitelist={['https://dexscreener.com']}
              onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
              javaScriptEnabled
              domStorageEnabled
              scrollEnabled={false}
              startInLoadingState
              renderLoading={() => <ActivityIndicator color={kivoTheme.colors.accent} style={styles.centered} />}
            />
          )}
      </View>

      <Modal visible={holdersOpen} transparent animationType="fade" onRequestClose={() => setHoldersOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setHoldersOpen(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Top holders</Text>
              <Pressable onPress={() => setHoldersOpen(false)} hitSlop={10}><Text style={styles.close}>Close</Text></Pressable>
            </View>
            {security?.flags.length ? <Text style={styles.flagList}>{security.flags.join('\n')}</Text> : null}
            <ScrollView style={styles.list}>
              {!holders?.length ? <Text style={styles.muted}>No holder data available for this token right now.</Text>
                : holders.map((holder, index) => (
                  <View key={holder.address} style={styles.holder}>
                    <Text style={styles.rank}>#{index + 1}</Text>
                    <View style={styles.flex}>
                      <Text style={styles.address} numberOfLines={1}>{holder.tag ?? `${holder.address.slice(0, 6)}…${holder.address.slice(-4)}`}</Text>
                      {(holder.isLocked || holder.isContract) && <Text style={styles.muted}>{[holder.isLocked && 'Locked', holder.isContract && 'Contract'].filter(Boolean).join(' · ')}</Text>}
                    </View>
                    <Text style={styles.percent}>{holder.percent != null ? `${holder.percent.toFixed(2)}%` : '—'}</Text>
                  </View>
                ))}
            </ScrollView>
            <Text style={styles.source}>Holder and risk data: GoPlus Security</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 38 },
  socials: { flex: 1, flexDirection: 'row', gap: 8 },
  iconButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: c.cream, fontSize: 14, fontWeight: '800' },
  flag: { color: '#F5C451', fontSize: 11.5, fontWeight: '800' },
  flagDanger: { color: c.danger },
  pill: { paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1, borderColor: c.border, justifyContent: 'center' },
  pillText: { color: c.text, fontWeight: '800', fontSize: 12 },
  chart: { height: 320, marginTop: 10, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: c.border, backgroundColor: CHART_BG, alignItems: 'center', justifyContent: 'center' },
  webview: { flex: 1, width: '100%', backgroundColor: CHART_BG },
  centered: { position: 'absolute', alignSelf: 'center', top: '45%' },
  muted: { color: c.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 20 },
  backdrop: { flex: 1, backgroundColor: 'rgba(1,15,13,0.7)', justifyContent: 'center', padding: 20 },
  card: { maxHeight: '75%', borderRadius: 22, padding: 18, backgroundColor: c.background, borderWidth: 1, borderColor: c.border },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  close: { color: c.accent, fontWeight: '800' },
  flagList: { color: '#F5C451', fontSize: 12, lineHeight: 18, marginBottom: 8 },
  list: { flexGrow: 0 },
  holder: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border },
  rank: { color: c.textMuted, fontWeight: '800', width: 30 },
  flex: { flex: 1 },
  address: { color: c.text, fontWeight: '700', fontSize: 13 },
  percent: { color: c.cream, fontWeight: '800' },
  source: { color: c.textMuted, fontSize: 10.5, marginTop: 10 },
});
