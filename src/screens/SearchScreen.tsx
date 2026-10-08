import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { CHAIN_LABEL, tradeChainLabel, type TradeChain, searchTokens, fmtCompactUsd } from '../trading/tokenSearch';
import { fetchTrendingTokens } from '@kivo/trading/core/discoveryFeed';
import { toKivoToken, type KivoToken } from '@kivo/trading/kivo/tokens';

type TokenSearchResult = KivoToken;


const DEBOUNCE_MS = 350;

export function SearchScreen({ onSelectToken }: { onSelectToken?: (result: TokenSearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [retry, setRetry] = useState(0);
  const [chainFilter, setChainFilter] = useState<'All' | TradeChain>('All');
  const chainFilters: Array<'All' | TradeChain> = ['All', 'ethereum', 'base', 'bnb', 'arbitrum', 'solana'];
  const [trending, setTrending] = useState<TokenSearchResult[]>([]);
  const [trendingError, setTrendingError] = useState('');
  useEffect(() => { fetchTrendingTokens().then(result => { setTrending(result.tokens.map(toKivoToken)); setTrendingError(result.error ?? ''); }); }, []);
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

  const source = query.trim() ? results : trending;
  const visibleResults = chainFilter === 'All' ? source : source.filter(item => item.chainKey === chainFilter);

  return (
    <View style={styles.root}>
      <Text style={styles.eyebrow}>KIVO SEARCH</Text>
      <Text style={styles.title}>What do you want to buy?</Text>

      <View style={styles.filters}>{chainFilters.map(filter => <Pressable key={filter} onPress={() => setChainFilter(filter)} style={[styles.filter, chainFilter === filter && styles.filterActive]}><Text style={[styles.filterText, chainFilter === filter && styles.filterTextActive]}>{filter === 'All' ? 'All chains' : tradeChainLabel(filter)}</Text></Pressable>)}</View>

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
        <Text style={styles.sectionTitle}>{trending.length ? 'Trending tokens' : trendingError || 'Loading trending tokens…'}</Text>
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
          {result.name} · {tradeChainLabel(result.chainKey)}
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
  root: { flex: 1, backgroundColor: kivoTheme.colors.background, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 0 },
  eyebrow: { color: kivoTheme.colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  title: { color: kivoTheme.colors.text, fontSize: 22, lineHeight: 27, fontWeight: '800', marginTop: 2, marginBottom: 12 },
  filters:{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:8},
  filter:{paddingHorizontal:11,paddingVertical:6,borderRadius:999,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border},
  filterActive:{backgroundColor:kivoTheme.colors.cream,borderColor:kivoTheme.colors.cream},
  filterText:{color:kivoTheme.colors.textMuted,fontSize:10,fontWeight:'700'},filterTextActive:{color:kivoTheme.colors.backgroundDeep},
  searchBox: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    backgroundColor: kivoTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  searchGlyph: { color: kivoTheme.colors.textMuted, fontSize: 21, lineHeight: 24, marginRight: 6 },
  input: { flex: 1, color: kivoTheme.colors.text, fontSize: 14, paddingVertical: 8 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 100 },
  stateTitle: { color: kivoTheme.colors.text, fontSize: 18, fontWeight: '800', marginBottom: 7 },
  hint: { color: kivoTheme.colors.textMuted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 18, height: 38, borderRadius: 19, backgroundColor: kivoTheme.colors.surfaceRaised, justifyContent: 'center' },
  retryText: { color: kivoTheme.colors.cream, fontWeight: '800' },
  list: { paddingTop: 4, paddingBottom: 28 },
  sectionTitle: { color: kivoTheme.colors.text, fontSize: 16, fontWeight: '800', marginTop: 8, marginBottom: 2 },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: kivoTheme.colors.border,
    paddingVertical: 8,
  },
  rowPressed: { opacity: 0.72 },
  icon: { width: 40, height: 40, borderRadius: 13, backgroundColor: kivoTheme.colors.surfaceRaised },
  iconFallback: {
    width: 44, height: 44, borderRadius: 15, backgroundColor: kivoTheme.colors.surfaceRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  iconLetter: { color: kivoTheme.colors.cream, fontWeight: '800', fontSize: 15 },
  copy: { flex: 1, minWidth: 0, marginLeft: 10, marginRight: 8 },
  symbol: { color: kivoTheme.colors.text, fontSize: 15, fontWeight: '800' },
  meta: { color: kivoTheme.colors.textMuted, fontSize: 11, marginTop: 2 },
  priceCol: { alignItems: 'flex-end' },
  price: { color: kivoTheme.colors.text, fontSize: 13.5, fontWeight: '800' },
  change: { fontSize: 11, fontWeight: '800', marginTop: 2 },
});
