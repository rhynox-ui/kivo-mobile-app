import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { kivoTheme } from '../theme/kivoTheme';
import { KivoModal } from './KivoModal';
import { NetworkIcon } from '../wallet/NetworkIcon';
import { tradeChainLabel, type TradeChain } from '@kivo/trading/core/chainData';

// "Attach token" for feed posts and chats, same flow as the web app: pick the
// network from a list (icon + name), paste the contract / mint, and Kivo
// checks the market by itself — no separate verify button.

export type VerifiedToken = { chain: string; address: string; symbol: string; name: string; imageUrl: string | null };

const NETWORKS: TradeChain[] = ['solana', 'ethereum', 'base', 'bnb', 'robinhood', 'arbitrum', 'avalanche', 'abstract', 'hyperevm', 'ink', 'plasma', 'unichain', 'xlayer', 'arc'];
const DEX_CHAIN: Record<string, string> = { ethereum: 'ethereum', base: 'base', bnb: 'bsc', robinhood: 'robinhood', solana: 'solana', arbitrum: 'arbitrum', avalanche: 'avalanche', abstract: 'abstract', hyperevm: 'hyperevm', ink: 'ink', plasma: 'plasma', unichain: 'unichain', xlayer: 'xlayer', arc: 'arc' };
const MARKET = 'https://kivo-web.pages.dev/api/market/dexscreener';

function validAddress(chain: string, address: string): boolean {
  return chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * The address inside whatever was pasted: a bare address, or a link from
 * DexScreener, GeckoTerminal, pump.fun, Birdeye, Solscan, Etherscan…
 */
export function addressFromInput(chain: string, input: string): string {
  const value = input.trim();
  const match = /^https?:\/\/[^/]+(\/[^?#]*)?(\?[^#]*)?/i.exec(value);
  if (!match) return value;
  const parts = `${match[1] ?? ''}/${(match[2] ?? '').replace(/^\?/, '').replace(/[&=]/g, '/')}`.split('/').map(part => { try { return decodeURIComponent(part).trim(); } catch { return part; } }).filter(Boolean).reverse();
  return parts.find(part => validAddress(chain, part)) ?? value;
}

/** A pasted pair (pool) address: the pair's base token. */
async function fromPair(chain: string, address: string): Promise<VerifiedToken | null> {
  try {
    const response = await fetch(`${MARKET}/latest/dex/pairs/${encodeURIComponent(DEX_CHAIN[chain])}/${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const body = await response.json();
    const pair = body?.pair ?? body?.pairs?.[0];
    const base = pair?.baseToken;
    if (!pair || pair.chainId !== DEX_CHAIN[chain] || typeof base?.address !== 'string' || !validAddress(chain, base.address) || !base.symbol) return null;
    return { chain, address: base.address, symbol: String(base.symbol).slice(0, 20), name: String(base.name || base.symbol).slice(0, 80), imageUrl: typeof pair.info?.imageUrl === 'string' && pair.info.imageUrl.startsWith('https://') ? pair.info.imageUrl : null };
  } catch { return null; }
}

/** Finds the token's most liquid market on that network; throws a readable reason when there is none. */
export async function verifyTokenMarket(chain: string, rawAddress: string): Promise<VerifiedToken> {
  const address = addressFromInput(chain, rawAddress);
  if (!validAddress(chain, address)) throw new Error(`That isn't a valid ${tradeChainLabel(chain as TradeChain)} token address.`);
  const chainId = DEX_CHAIN[chain];
  let pairs: any[] = [];
  let response = await fetch(`${MARKET}/latest/dex/tokens/${encodeURIComponent(address)}`);
  if (response.ok) { const data = await response.json(); pairs = Array.isArray(data.pairs) ? data.pairs : []; }
  if (!pairs.length) {
    response = await fetch(`${MARKET}/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(address)}`);
    if (response.ok) { const data = await response.json(); pairs = Array.isArray(data) ? data : Array.isArray(data.pairs) ? data.pairs : []; }
  }
  const same = (a: unknown) => typeof a === 'string' && (chain === 'solana' ? a === address : a.toLowerCase() === address.toLowerCase());
  const pair = pairs.filter(p => p.chainId === chainId && p.pairAddress && (same(p.baseToken?.address) || same(p.quoteToken?.address)))
    .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
  if (!pair) {
    // Not on DexScreener yet (new launches, pump.fun tokens on their bonding curve).
    const fallback = await fromPair(chain, address) ?? await fromGeckoTerminal(chain, address) ?? (chain === 'solana' ? await fromJupiter(address) : null);
    if (fallback) return fallback;
    throw new Error(`No market found for this token on ${tradeChainLabel(chain as TradeChain)}. Check the network and the address.`);
  }
  const details = same(pair.baseToken?.address) ? pair.baseToken : pair.quoteToken;
  if (!details?.symbol) throw new Error('Market data did not include a token symbol.');
  return { chain, address, symbol: String(details.symbol).slice(0, 20), name: String(details.name || details.symbol).slice(0, 80), imageUrl: typeof pair.info?.imageUrl === 'string' && pair.info.imageUrl.startsWith('https://') ? pair.info.imageUrl : null };
}

const GECKO_NETWORK: Record<string, string> = { ethereum: 'eth', base: 'base', bnb: 'bsc', robinhood: 'robinhood', solana: 'solana', arbitrum: 'arbitrum', avalanche: 'avax', abstract: 'abstract', hyperevm: 'hyperevm', ink: 'ink', plasma: 'plasma', unichain: 'unichain', xlayer: 'x-layer', arc: 'arc' };
const httpsOrNull = (value: unknown) => typeof value === 'string' && value.startsWith('https://') ? value : null;

async function fromGeckoTerminal(chain: string, address: string): Promise<VerifiedToken | null> {
  const network = GECKO_NETWORK[chain];
  if (!network) return null;
  try {
    const response = await fetch(`https://kivo-web.pages.dev/api/market/geckoterminal/api/v2/networks/${network}/tokens/${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const body = await response.json();
    const attributes = body?.data?.attributes;
    if (!attributes?.symbol || !body?.data?.relationships?.top_pools?.data?.length) return null;
    return { chain, address, symbol: String(attributes.symbol).slice(0, 20), name: String(attributes.name || attributes.symbol).slice(0, 80), imageUrl: httpsOrNull(attributes.image_url) };
  } catch { return null; }
}

async function fromJupiter(address: string): Promise<VerifiedToken | null> {
  try {
    const response = await fetch(`https://kivo-web.pages.dev/api/market/jupiter/tokens/v2/search?query=${encodeURIComponent(address)}`);
    if (!response.ok) return null;
    const rows = await response.json();
    const token = Array.isArray(rows) ? rows.find((row: { id?: string }) => row.id === address) : null;
    if (!token?.symbol) return null;
    return { chain: 'solana', address, symbol: String(token.symbol).slice(0, 20), name: String(token.name || token.symbol).slice(0, 80), imageUrl: httpsOrNull(token.icon) };
  } catch { return null; }
}

export function TokenAttachmentPicker({ onChange, onClose, initialChain = 'solana' }: { onChange: (token: VerifiedToken | null) => void; onClose?: () => void; initialChain?: string }) {
  const [chain, setChain] = useState(initialChain);
  const [address, setAddress] = useState('');
  const [state, setState] = useState<{ status: 'idle' | 'checking' | 'ok' | 'error'; token?: VerifiedToken; error?: string }>({ status: 'idle' });
  const [networksOpen, setNetworksOpen] = useState(false);
  const seq = useRef(0);

  // Check the market as soon as a valid-looking address is there (debounced).
  useEffect(() => {
    const value = addressFromInput(chain, address);
    const id = ++seq.current;
    onChange(null);
    if (!value) { setState({ status: 'idle' }); return; }
    if (!validAddress(chain, value)) { setState({ status: value.length > 30 ? 'error' : 'idle', error: `That isn't a valid ${tradeChainLabel(chain as TradeChain)} token address.` }); return; }
    setState({ status: 'checking' });
    const timer = setTimeout(() => {
      verifyTokenMarket(chain, value).then(token => {
        if (id !== seq.current) return;
        setState({ status: 'ok', token }); onChange(token);
      }, error => {
        if (id !== seq.current) return;
        setState({ status: 'error', error: error instanceof Error ? error.message : 'Could not check this token.' });
      });
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, address]);

  const paste = async () => { try { const text = (await Clipboard.getString()).trim(); if (text) setAddress(text); } catch { /* clipboard unavailable */ } };

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>Attach token</Text>
        {onClose ? <Pressable onPress={() => { onChange(null); onClose(); }} hitSlop={10} accessibilityLabel="Remove token attachment"><Text style={styles.close}>✕</Text></Pressable> : null}
      </View>
      <Pressable onPress={() => setNetworksOpen(true)} style={styles.network} accessibilityRole="button" accessibilityLabel="Choose network">
        <NetworkIcon chainKey={chain as never} size={24} />
        <Text style={styles.networkName}>{tradeChainLabel(chain as TradeChain)}</Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <View style={styles.inputRow}>
        <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} placeholder="Paste token address or market link" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
        {address ? <Pressable onPress={() => setAddress('')} hitSlop={8}><Text style={styles.paste}>Clear</Text></Pressable> : <Pressable onPress={() => void paste()} hitSlop={8}><Text style={styles.paste}>Paste</Text></Pressable>}
      </View>
      {state.status === 'checking' ? <View style={styles.statusRow}><ActivityIndicator size="small" color={kivoTheme.colors.accent} /><Text style={styles.muted}>Checking market…</Text></View> : null}
      {state.status === 'error' ? <Text style={styles.error}>{state.error}</Text> : null}
      {state.status === 'ok' && state.token ? (
        <View style={styles.preview}>
          {state.token.imageUrl ? <Image source={{ uri: state.token.imageUrl }} style={styles.previewIcon} /> : <View style={styles.previewIcon} />}
          <View style={styles.flex}>
            <Text style={styles.previewName} numberOfLines={1}>${state.token.symbol} · {state.token.name}</Text>
            <Text style={styles.muted}>{tradeChainLabel(chain as TradeChain)} · {state.token.address.slice(0, 6)}…{state.token.address.slice(-5)}</Text>
          </View>
          <Text style={styles.ok}>✓</Text>
        </View>
      ) : null}

      <KivoModal visible={networksOpen} transparent animationType="slide" onRequestClose={() => setNetworksOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setNetworksOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.head}>
              <Text style={styles.sheetTitle}>Choose network</Text>
              <Pressable onPress={() => setNetworksOpen(false)} hitSlop={10}><Text style={styles.close}>✕</Text></Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {NETWORKS.map(key => (
                <Pressable key={key} onPress={() => { setChain(key); setNetworksOpen(false); }} style={[styles.networkRow, chain === key && styles.networkRowActive]} accessibilityRole="button">
                  <NetworkIcon chainKey={key as never} size={26} />
                  <Text style={styles.networkName}>{tradeChainLabel(key)}</Text>
                  <View style={[styles.radio, chain === key && styles.radioOn]} />
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KivoModal>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  panel: { padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 10, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { color: c.text, fontWeight: '800', fontSize: 14 },
  close: { color: c.textMuted, fontSize: 18, fontWeight: '800' },
  network: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  networkName: { flex: 1, color: c.text, fontWeight: '800', fontSize: 15 },
  chevron: { color: c.textMuted, fontSize: 22 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, borderRadius: 14, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: c.border },
  input: { flex: 1, color: c.text, fontSize: 14, paddingVertical: 12 },
  paste: { color: c.accent, fontWeight: '800', fontSize: 13 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: c.textMuted, fontSize: 12 },
  error: { color: c.danger, fontSize: 12, lineHeight: 17 },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, backgroundColor: c.backgroundDeep },
  previewIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.surfaceRaised },
  previewName: { color: c.text, fontWeight: '800', fontSize: 14 },
  ok: { color: c.success, fontSize: 18, fontWeight: '900' },
  flex: { flex: 1, minWidth: 0 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 28, maxHeight: '85%', borderWidth: 1, borderColor: c.border },
  sheetTitle: { color: c.cream, fontSize: 18, fontWeight: '900', marginBottom: 12 },
  networkRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginBottom: 8 },
  networkRowActive: { borderColor: c.accent },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.textMuted },
  radioOn: { borderColor: c.accent, backgroundColor: c.accent },
});
