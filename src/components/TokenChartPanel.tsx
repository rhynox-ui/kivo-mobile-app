import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { MAINNET_CHAIN_IDS } from '@kivo/trading/core/chainData';
import { kivoTheme } from '../theme/kivoTheme';
import { dexScreenerEmbedUrl, resolveDexScreenerPair, type ResolvedPair } from '@kivo/trading/core/dexScreener';
import { checkSolanaTokenSecurity, checkTokenSecurity, type TokenSecuritySummary } from '@kivo/trading/core/goplusTokenSecurity';
import { isNativeToken, marketAddressFor, type KivoToken } from '@kivo/trading/kivo/tokens';
import { fetchSolanaTopHolders } from '@kivo/trading/kivo/solanaHolders';
import type { TokenHolder } from '@kivo/trading/core/goplusTokenSecurity';
import { openHttpsUrl } from '../utils/openExternal';
import { withSocialFallback } from '../state/tokenSocials';
import { KivoModal } from './KivoModal';

const COLORS = {
  background: kivoTheme.colors.background,
  panel: kivoTheme.colors.surface,
  pill: kivoTheme.colors.surfaceRaised,
  border: kivoTheme.colors.border,
  text: kivoTheme.colors.text,
  secondary: kivoTheme.colors.creamMuted,
  muted: kivoTheme.colors.textMuted,
  danger: kivoTheme.colors.danger,
  accent: kivoTheme.colors.accent,
};
const CHART_BG = kivoTheme.colors.backgroundDeep;

function compact(value: number) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K';
  return value.toFixed(0);
}

export function TokenChartPanel({ token }: { token: KivoToken }) {
  const [pair, setPair] = useState<ResolvedPair | null>(null);
  const [resolving, setResolving] = useState(true);
  const [security, setSecurity] = useState<TokenSecuritySummary | null>(null);
  const [holdersOpen, setHoldersOpen] = useState(false);
  // Solana tokens GoPlus hasn't indexed yet: holders read from the network when the sheet opens.
  const [networkHolders, setNetworkHolders] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; holders: TokenHolder[] }>({ status: 'idle', holders: [] });
  useEffect(() => { setNetworkHolders({ status: 'idle', holders: [] }); }, [token.chainKey, token.tokenAddress]);

  useEffect(() => {
    let cancelled = false;
    setPair(null);
    setResolving(true);
    setSecurity(null);

    // A native coin (ETH, SOL…) charts as its wrapped coin and needs no contract security check.
    const marketAddress = marketAddressFor(token);
    (marketAddress ? resolveDexScreenerPair({ chainKey: token.chainKey, tokenAddress: marketAddress }) : Promise.resolve(null))
      .then(result => { if (!cancelled) setPair(result); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setResolving(false); });

    if (isNativeToken(token)) return () => { cancelled = true; };
    const lookup = token.chainKey === 'solana'
      ? checkSolanaTokenSecurity(token.tokenAddress)
      : checkTokenSecurity((MAINNET_CHAIN_IDS as Partial<Record<string, number>>)[token.chainKey], token.tokenAddress);
    lookup.then(result => { if (!cancelled) setSecurity(result); }).catch(() => {});

    return () => { cancelled = true; };
  }, [token.chainKey, token.tokenAddress]);

  const embedUrl = pair ? dexScreenerEmbedUrl({
    chainId: pair.chainId,
    pairAddress: pair.pairAddress,
    theme: 'dark',
  }) : null;

  const useNetworkHolders = token.chainKey === 'solana' && !isNativeToken(token) && !security?.holders?.length;
  const holders = useNetworkHolders ? networkHolders.holders : security?.holders ?? null;
  const openHolders = () => {
    setHoldersOpen(true);
    if (!useNetworkHolders || networkHolders.status === 'loading' || networkHolders.status === 'ok') return;
    setNetworkHolders({ status: 'loading', holders: [] });
    fetchSolanaTopHolders(token.tokenAddress)
      .then(list => setNetworkHolders({ status: 'ok', holders: list }))
      .catch(() => setNetworkHolders({ status: 'error', holders: [] }));
  };
  const holderCount = security?.holderCount ?? null;
  // DexScreener's links, with website / X / Telegram filled from GeckoTerminal or Jupiter when missing.
  const [socialLinks, setSocialLinks] = useState<{ kind: string; url: string }[]>([]);
  useEffect(() => {
    let active = true;
    const base = pair?.socialLinks ?? [];
    setSocialLinks(base);
    if (token.chainKey === "near") return () => { active = false; };
    void withSocialFallback(token.chainKey, token.tokenAddress, base).then(links => { if (active) setSocialLinks(links); });
    return () => { active = false; };
  }, [pair, token.chainKey, token.tokenAddress]);
  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest) =>
    /^https:\/\/([a-z0-9-]+\.)*dexscreener\.com\//i.test(request.url);

  return (
    <View style={styles.wrap}>
      {(holderCount != null || (holders?.length ?? 0) > 0 || useNetworkHolders || socialLinks.length > 0) && (
        <View style={styles.holdersRow}>
          <View style={styles.socialLinksRow}>
            {socialLinks.map(link => (
              <Pressable
                key={link.url}
                onPress={() => openHttpsUrl(link.url)}
                style={styles.socialIconButton}
                accessibilityLabel={link.kind}>
                <Text style={styles.socialIconText}>
                  {link.kind === 'x' ? '𝕏' : link.kind === 'telegram' ? '✈' : '◎'}
                </Text>
              </Pressable>
            ))}
          </View>
          {(holderCount != null || (holders?.length ?? 0) > 0 || useNetworkHolders) && (
            <Pressable onPress={openHolders} style={styles.holdersButton}>
              <Text style={styles.holdersButtonText}>
                {holderCount != null ? `Holders ${compact(holderCount)}` : 'Top holders'} ▾
              </Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.chartArea}>
        {resolving ? (
          <ActivityIndicator color={kivoTheme.colors.textMuted} style={styles.centered} />
        ) : !embedUrl ? (
          <Text style={styles.errorText}>DexScreener hasn't indexed a pair for this token on this network yet.</Text>
        ) : (
          <WebView
            key={embedUrl}
            source={{ uri: embedUrl }}
            style={styles.webview}
            containerStyle={styles.webviewContainer}
            originWhitelist={['https://dexscreener.com']}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            javaScriptEnabled
            domStorageEnabled
            scrollEnabled={false}
            backgroundColor={CHART_BG}
            renderLoading={() => <ActivityIndicator color="#77777D" style={styles.centered} />}
            startInLoadingState
          />
        )}
      </View>

      <KivoModal visible={holdersOpen} transparent animationType="fade" onRequestClose={() => setHoldersOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setHoldersOpen(false)}>
          <Pressable style={styles.holdersCard} onPress={() => {}}>
            <View style={styles.holdersHeader}>
              <Text style={styles.holdersTitle}>Top holders</Text>
              <Pressable onPress={() => setHoldersOpen(false)} hitSlop={10}>
                <Text style={styles.holdersClose}>Close</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.holdersList}>
              {useNetworkHolders && networkHolders.status === 'loading' ? (
                <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginVertical: 24 }} />
              ) : !holders?.length ? (
                <Text style={styles.holdersEmpty}>{useNetworkHolders && networkHolders.status === 'error' ? 'Could not read holders from the Solana network. Try again in a moment.' : 'No holder data available for this token right now.'}</Text>
              ) : (
                holders.map((holder, index) => (
                  <View key={holder.address} style={styles.holderRow}>
                    <Text style={styles.rank}>#{index + 1}</Text>
                    <View style={styles.flex}>
                      <Text style={styles.address} numberOfLines={1}>
                        {holder.tag ?? `${holder.address.slice(0, 6)}…${holder.address.slice(-4)}`}
                      </Text>
                      {(holder.isLocked || holder.isContract) && (
                        <Text style={styles.muted}>
                          {[holder.isLocked && 'Locked', holder.isContract && 'Contract'].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                    </View>
                    <Text style={styles.percent}>{holder.percent != null ? `${holder.percent.toFixed(2)}%` : '—'}</Text>
                  </View>
                ))
              )}
            </ScrollView>
            <Text style={styles.source}>
              {useNetworkHolders ? 'Top 10 holders only, read from the Solana network. Includes pools and launchpad accounts.' : `Top 10 ${token.chainKey === 'solana' ? 'token accounts' : 'holders'} only, via GoPlus Security.`}
            </Text>
          </Pressable>
        </Pressable>
      </KivoModal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 390, overflow: 'hidden' },
  holdersRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  socialLinksRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  socialIconButton: { backgroundColor: COLORS.pill, borderRadius: 999, width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  socialIconText: { color: COLORS.secondary, fontSize: 15, fontWeight: '600' },
  holdersButton: { backgroundColor: COLORS.pill, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  holdersButtonText: { color: COLORS.text, fontSize: 10.5, fontWeight: '700' },
  chartArea: {
    height: 390,
    justifyContent: 'center',
    backgroundColor: CHART_BG,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  webview: { flex: 1, backgroundColor: CHART_BG },
  webviewContainer: { flex: 1, backgroundColor: CHART_BG },
  centered: { alignSelf: 'center' },
  errorText: { color: kivoTheme.colors.textMuted, fontSize: 12, textAlign: 'center', marginHorizontal: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  holdersCard: { backgroundColor: COLORS.panel, borderColor: COLORS.border, borderWidth: 1, borderRadius: 16, maxHeight: '75%', overflow: 'hidden' },
  holdersHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  holdersTitle: { color: COLORS.text, fontSize: 14, fontWeight: '800' },
  holdersClose: { color: COLORS.secondary, fontSize: 12, fontWeight: '600' },
  holdersList: { paddingHorizontal: 16 },
  holdersEmpty: { color: COLORS.muted, fontSize: 12, textAlign: 'center', paddingVertical: 24 },
  holderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  rank: { color: COLORS.muted, fontSize: 11.5, fontWeight: '700', width: 24 },
  flex: { flex: 1, minWidth: 0 },
  address: { color: COLORS.text, fontSize: 12.5, fontWeight: '700' },
  muted: { color: COLORS.muted, fontSize: 10.5, marginTop: 2 },
  percent: { color: COLORS.text, fontSize: 12.5, fontWeight: '700' },
  source: { color: COLORS.muted, fontSize: 10, textAlign: 'center', paddingHorizontal: 16, paddingVertical: 12 },
});