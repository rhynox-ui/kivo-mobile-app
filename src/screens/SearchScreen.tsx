import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { CHAIN_LABEL, tradeChainLabel, type TradeChain, searchTokens, fmtCompactUsd } from '../trading/tokenSearch';
import { fetchTrendingTokens, fetchTrendingTokensForChain } from '@kivo/trading/core/discoveryFeed';
import { toKivoToken, type KivoToken } from '@kivo/trading/kivo/tokens';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TOKEN_SORT_OPTIONS, sortTokens, type TokenSortKey } from '@kivo/trading/kivo/sort';

type TokenSearchResult = KivoToken;


const DEBOUNCE_MS = 350;
const TRENDING_CACHE = 'kivo:trending:v1';
const TRENDING_FRESH_MS = 60_000;
let trendingMemory: {tokens: KivoToken[]; at: number} | null = null;
const chainTrendingMemory = new Map<string, {tokens: KivoToken[]; at: number}>();

export function SearchScreen({ onSelectToken }: { onSelectToken?: (result: TokenSearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [retry, setRetry] = useState(0);
  const [chainFilter, setChainFilter] = useState<'All' | TradeChain>('All');
  const [sort, setSort] = useState<TokenSortKey>('default');
  const [sortOpen, setSortOpen] = useState(false);
  const [menuTop, setMenuTop] = useState(0);
  // Every chain Kivo trades on, popular ones first.
  const chainFilters: Array<'All' | TradeChain> = ['All', 'solana', 'base', 'ethereum', 'bnb', 'robinhood', 'arbitrum', 'avalanche', 'unichain', 'hyperevm', 'ink', 'abstract', 'plasma', 'stable', 'xlayer', 'arc'].filter(key => key === 'All' || key in CHAIN_LABEL) as Array<'All' | TradeChain>;
  const [chainTrending, setChainTrending] = useState<{ chain: TradeChain; tokens: TokenSearchResult[]; error: string } | null>(null);
  const [trending, setTrending] = useState<TokenSearchResult[]>(() => trendingMemory?.tokens ?? []);
  const [trendingError, setTrendingError] = useState('');
  useEffect(() => {
    // Show the last list straight away (memory, then the phone), refresh in the background.
    if (!trendingMemory) void AsyncStorage.getItem(TRENDING_CACHE).then(raw => { if (raw && !trendingMemory) setTrending(current => current.length ? current : (JSON.parse(raw) as KivoToken[])); }).catch(() => {});
    if (trendingMemory && Date.now() - trendingMemory.at < TRENDING_FRESH_MS) return;
    fetchTrendingTokens().then(result => {
      const tokens = result.tokens.map(toKivoToken);
      if (tokens.length) { trendingMemory = {tokens, at: Date.now()}; AsyncStorage.setItem(TRENDING_CACHE, JSON.stringify(tokens)).catch(() => {}); }
      setTrending(current => tokens.length ? tokens : current);
      setTrendingError(tokens.length ? '' : result.error ?? '');
    });
  }, []);
  // A chain filter loads that chain's own trending list, so smaller chains
  // (Robinhood, Unichain, ...) are not crowded out of the mixed list.
  useEffect(() => {
    if (chainFilter === 'All' || chainFilter === 'near') { setChainTrending(null); return; }
    let active = true;
    const cached = chainTrendingMemory.get(chainFilter);
    setChainTrending(cached ? { chain: chainFilter, tokens: cached.tokens, error: '' } : null);
    if (cached && Date.now() - cached.at < TRENDING_FRESH_MS) return;
    fetchTrendingTokensForChain(chainFilter).then(result => {
      const tokens = result.tokens.map(toKivoToken);
      if (tokens.length) chainTrendingMemory.set(chainFilter, {tokens, at: Date.now()});
      if (active && (tokens.length || !cached)) setChainTrending({ chain: chainFilter, tokens, error: result.error ?? '' });
    });
    return () => { active = false; };
  }, [chainFilter]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();

    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setSearched(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      searchTokens(trimmed).then(found => {
        if (requestId !== requestIdRef.current) return;
        setResults(found.map(toKivoToken));
        setSearchError('');
        setLoading(false);
        setSearched(true);
      }).catch(error => {
        if (requestId !== requestIdRef.current) return;
        setResults([]);
        setSearchError(error instanceof Error ? error.message : 'Search could not reach market data. Try again.');
        setLoading(false);
        setSearched(true);
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      requestIdRef.current += 1;
    };
  }, [query, retry]);

  const chainList = chainFilter !== 'All' && chainTrending?.chain === chainFilter ? chainTrending.tokens : null;
  const source = query.trim() ? results : chainList ?? trending;
  const filtered = chainFilter === 'All' ? source : source.filter(item => item.chainKey === chainFilter);
  const visibleResults = sortTokens(filtered, sort);

  return (
    <View style={styles.root}>
      <View style={styles.filterBar} onLayout={event => setMenuTop(event.nativeEvent.layout.y + event.nativeEvent.layout.height + 4)}>
        <Pressable onPress={() => setSortOpen(open => !open)} style={[styles.sortButton, sort !== 'default' && styles.sortButtonActive]} accessibilityRole="button" accessibilityLabel="Sort tokens" hitSlop={4}>
          <View style={[styles.sortLine, { width: 14 }]} /><View style={[styles.sortLine, { width: 10 }]} /><View style={[styles.sortLine, { width: 6 }]} />
        </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filters}>{chainFilters.map(filter => <Pressable key={filter} onPress={() => setChainFilter(filter)} style={[styles.filter, chainFilter === filter && styles.filterActive]}><Text style={[styles.filterText, chainFilter === filter && styles.filterTextActive]}>{filter === 'All' ? 'All chains' : tradeChainLabel(filter)}</Text></Pressable>)}</ScrollView>
      </View>

      <View style={styles.searchBox}>
        <Text style={styles.searchGlyph}>⌕</Text>
        <TextInput
                    value={query}
          onChangeText={setQuery}
          placeholder="Search any token, any chain"
          placeholderTextColor={kivoTheme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {loading && <ActivityIndicator size="small" color={kivoTheme.colors.accent} />}
      </View>

      {!loading && searched && searchError ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>Search unavailable</Text>
          <Text style={styles.hint}>{searchError}</Text>
          <Pressable onPress={() => setRetry(n => n + 1)} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Pressable>
        </View>
      ) : null}

      {!loading && searched && !searchError && visibleResults.length === 0 && (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>No tokens found</Text>
          <Text style={styles.hint}>Try a token name, ticker, or another search term.</Text>
        </View>
      )}

      {!loading && !query.trim() && (
        <Text style={styles.sectionTitle}>{chainFilter !== 'All' ? (chainList ? (chainList.length ? `Trending on ${tradeChainLabel(chainFilter)}` : chainTrending?.error || 'No trending tokens on this network right now.') : `Loading ${tradeChainLabel(chainFilter)}…`) : trending.length ? 'Trending tokens' : trendingError || 'Loading trending tokens…'}</Text>
      )}

      {visibleResults.length > 0 && (
        <FlatList
          data={visibleResults}
          keyExtractor={item => `${item.chainKey}:${item.tokenAddress}`}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <TokenRow result={item} onPress={() => onSelectToken?.(item)} />}
        />
      )}

      {sortOpen ? (
        <>
          <Pressable style={styles.sortBackdrop} onPress={() => setSortOpen(false)} accessibilityLabel="Close sort menu" />
          <View style={[styles.sortMenu, { top: menuTop }]}>
            <Text style={styles.sortHeading}>SORT BY</Text>
            {TOKEN_SORT_OPTIONS.map(option => (
              <Pressable key={option.key} onPress={() => { setSort(option.key); setSortOpen(false); }} style={({ pressed }) => [styles.sortItem, pressed && styles.rowPressed]} accessibilityRole="button" accessibilityState={{ selected: sort === option.key }}>
                <Text style={[styles.sortItemText, sort === option.key && styles.sortItemTextActive]}>{option.label}</Text>
                {sort === option.key ? <Text style={styles.sortCheck}>✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function TokenRow({ result, onPress }: { result: TokenSearchResult; onPress: () => void }) {
  const positive = (result.change24h ?? 0) >= 0;
  const marketCap = fmtCompactUsd(result.marketCapUsd);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {result.imageUrl ? (
        <Image source={{ uri: result.imageUrl }} style={styles.icon} />
      ) : (
        <View style={styles.iconFallback}><Text style={styles.iconLetter}>{result.symbol.slice(0, 1).toUpperCase()}</Text></View>
      )}

      <View style={styles.copy}>
        <Text style={styles.symbol} numberOfLines={1}>{result.symbol}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {tradeChainLabel(result.chainKey)}
          {marketCap ? ` · ${marketCap} MC` : ''}
        </Text>
      </View>

      <View style={styles.priceCol}>
        <Text style={styles.price}>
          {result.priceUsd != null ? `$${result.priceUsd.toPrecision(4)}` : '—'}
        </Text>
        {result.change24h != null && (
          <Text style={[styles.change, { color: positive ? kivoTheme.colors.success : kivoTheme.colors.danger }]}>
            {positive ? '▲' : '▼'} {Math.abs(result.change24h).toFixed(2)}%
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 0 },
  filterBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  filterScroll: { flexGrow: 0, flexShrink: 1 },
  sortButton: { width: 30, height: 28, borderRadius: 10, borderWidth: 1, borderColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.surface, alignItems: 'center', justifyContent: 'center', gap: 2.5 },
  sortButtonActive: { borderColor: kivoTheme.colors.accent },
  sortLine: { height: 1.5, borderRadius: 1, backgroundColor: kivoTheme.colors.cream },
  sortBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  sortMenu: { position: 'absolute', left: 16, right: 16, zIndex: 21, elevation: 12, borderRadius: kivoTheme.radius.lg, backgroundColor: kivoTheme.colors.surface, borderWidth: 1, borderColor: kivoTheme.colors.border, paddingVertical: 10 },
  sortHeading: { color: kivoTheme.colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 6 },
  sortItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 11 },
  sortItemText: { color: kivoTheme.colors.text, fontSize: 14.5, fontWeight: '700' },
  sortItemTextActive: { color: kivoTheme.colors.accent },
  sortCheck: { color: kivoTheme.colors.accent, fontSize: 16, fontWeight: '900' },
  filters: { flexDirection: 'row', gap: 6, paddingRight: 16 },
  filter: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, backgroundColor: kivoTheme.colors.surface, borderWidth: 1, borderColor: kivoTheme.colors.border },
  filterActive: { backgroundColor: kivoTheme.colors.cream, borderColor: kivoTheme.colors.cream },
  filterText: { color: kivoTheme.colors.textMuted, fontSize: 10, fontWeight: '700' },
  filterTextActive: { color: kivoTheme.colors.backgroundDeep },
  searchBox: { minHeight: 38, borderRadius: 12, borderWidth: 1, borderColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  searchGlyph: { color: kivoTheme.colors.textMuted, fontSize: 18, lineHeight: 21, marginRight: 6 },
  input: { flex: 1, color: kivoTheme.colors.text, fontSize: 14, paddingVertical: 6 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 100 },
  stateTitle: { color: kivoTheme.colors.text, fontSize: 18, fontWeight: '800', marginBottom: 7 },
  hint: { color: kivoTheme.colors.textMuted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 18, height: 38, borderRadius: 19, backgroundColor: kivoTheme.colors.surfaceRaised, justifyContent: 'center' },
  retryText: { color: kivoTheme.colors.cream, fontWeight: '800' },
  list: { paddingTop: 4, paddingBottom: 28 },
  sectionTitle: { color: kivoTheme.colors.text, fontSize: 15, fontWeight: '800', marginTop: 6, marginBottom: 0 },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: kivoTheme.colors.border, paddingVertical: 8 },
  rowPressed: { opacity: 0.72 },
  icon: { width: 40, height: 40, borderRadius: 13, backgroundColor: kivoTheme.colors.surfaceRaised },
  iconFallback: { width: 40, height: 40, borderRadius: 13, backgroundColor: kivoTheme.colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  iconLetter: { color: kivoTheme.colors.cream, fontWeight: '800', fontSize: 15 },
  copy: { flex: 1, minWidth: 0, marginLeft: 10, marginRight: 8 },
  symbol: { color: kivoTheme.colors.text, fontSize: 15, fontWeight: '800' },
  meta: { color: kivoTheme.colors.textMuted, fontSize: 11, marginTop: 2 },
  priceCol: { alignItems: 'flex-end' },
  price: { color: kivoTheme.colors.text, fontSize: 13.5, fontWeight: '800' },
  change: { fontSize: 11, fontWeight: '800', marginTop: 2 },
});