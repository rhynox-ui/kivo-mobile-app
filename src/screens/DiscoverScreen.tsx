import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ApiCommunity, ApiProfile } from '@kivo/shared/api/types';
import { rememberProfiles } from '@kivo/shared/chat/store';
import type { KivoToken } from '@kivo/trading/kivo/tokens';
import { SearchScreen } from './SearchScreen';
import { Avatar } from './ChatListScreen';
import { kivoTheme } from '../theme/kivoTheme';
import { api } from '../state/session';
import { getWalletSession } from '../state/walletStore';

type Mode = 'tokens' | 'channels' | 'groups' | 'people';
const MODES: Array<[Mode, string]> = [['tokens', 'Tokens'], ['channels', 'Channels'], ['groups', 'Groups'], ['people', 'People']];

export function DiscoverScreen({ onSelectToken, onOpenChat, onOpenCommunity, onOpenPerson }: {
  onSelectToken: (token: KivoToken) => void;
  onOpenChat: (id: string) => void;
  onOpenCommunity: (id: string) => void;
  onOpenPerson: (userId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('tokens');
  return (
    <View style={styles.root}>
      <View style={styles.switcher}>
        {MODES.map(([value, label]) => (
          <Pressable key={value} onPress={() => setMode(value)} style={[styles.tab, mode === value && styles.activeTab]} accessibilityRole="tab" accessibilityState={{ selected: mode === value }}>
            <Text style={[styles.tabText, mode === value && styles.activeText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {mode === 'tokens' ? <SearchScreen onSelectToken={onSelectToken} />
        : mode === 'people' ? <People onOpenPerson={onOpenPerson} />
        : <Communities kind={mode === 'channels' ? 'channel' : 'group'} onOpenChat={onOpenChat} onOpenCommunity={onOpenCommunity} />}
    </View>
  );
}

function Communities({ kind, onOpenChat, onOpenCommunity }: { kind: 'group' | 'channel'; onOpenChat: (id: string) => void; onOpenCommunity: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ApiCommunity[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setItems(null);
    const t = setTimeout(() => api.discover(kind, query.trim()).then(list => { setItems(list); setError(''); }).catch(e => { setItems([]); setError(e instanceof Error ? e.message : 'Could not load.'); }), 250);
    return () => clearTimeout(t);
  }, [kind, query]);
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <TextInput value={query} onChangeText={setQuery} placeholder={`Search public ${kind}s`} placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {items == null ? <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 20 }} /> : items.length === 0 ? <Text style={styles.muted}>No public {kind}s yet.</Text> : items.map(c => (
        <Pressable key={c.id} onPress={() => (c.myRole ? onOpenChat(c.id) : onOpenCommunity(c.id))} style={styles.card}>
          <Avatar name={c.name} uri={c.avatarUrl} size={48} />
          <View style={styles.flex}>
            <View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{c.name}</Text>{kind === 'channel' && (c.isVerified || c.id === 'ch_671d27c151fefc25c8e5') ? <Text accessibilityLabel="Verified channel" style={styles.verifiedBadge}>★</Text> : null}</View>
            <Text style={styles.small}>{c.memberCount} {kind === 'channel' ? 'subscribers' : 'members'} · {c.postCount} {kind === 'channel' ? 'posts' : 'messages'}</Text>
            {c.description ? <Text style={styles.small} numberOfLines={2}>{c.description}</Text> : null}
          </View>
          <Text style={styles.role}>{c.myRole ? c.myRole.toUpperCase() : 'VIEW'}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function People({ onOpenPerson }: { onOpenPerson: (userId: string) => void }) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<ApiProfile[]>([]);
  const [verifiedPeople, setVerifiedPeople] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let active = true;
    void Promise.all(people.map(async person => {
      try { const status = await api.verificationStatus('profile', person.userId); return status.isVerified === true ? person.userId : null; }
      catch { return null; }
    })).then(results => { if (active) setVerifiedPeople(new Set(results.filter((id): id is string => Boolean(id)))); });
    return () => { active = false; };
  }, [people]);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setPeople([]); return; }
    const t = setTimeout(() => api.searchProfiles(q).then(found => { rememberProfiles(found); setPeople(found); }).catch(() => setPeople([])), 300);
    return () => clearTimeout(t);
  }, [query]);
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());
  const me = getWalletSession()?.address.toLowerCase();
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <TextInput value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholder="@username or 0x wallet address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
      <Text style={styles.muted}>Usernames are display names — a wallet session, not a username or badge, proves who owns a wallet.</Text>
      {isAddress && !people.length && <Pressable onPress={() => onOpenPerson('kivo:' + query.trim().toLowerCase())} style={styles.card}><Avatar name={query.trim().slice(2)} size={42} /><Text style={styles.name}>{query.trim().slice(0, 6)}…{query.trim().slice(-4)}</Text></Pressable>}
      {people.filter(p => p.address !== me).map(p => (
        <Pressable key={p.userId} onPress={() => onOpenPerson(p.userId)} style={styles.card}>
          <Avatar name={p.username ?? p.address} uri={p.avatarUrl} size={42} />
          <View style={styles.flex}><View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{p.username ? '@' + p.username : p.address}</Text>{verifiedPeople.has(p.userId) ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verifiedBadge}>★</Text> : null}</View>{p.bio ? <Text style={styles.small} numberOfLines={1}>{p.bio}</Text> : null}</View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  switcher: { flexDirection: 'row', marginHorizontal: 16, marginTop: 10, marginBottom: 4, padding: 4, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 999 },
  activeTab: { backgroundColor: c.cream },
  tabText: { color: c.textMuted, fontSize: 11, fontWeight: '800' },
  activeText: { color: c.backgroundDeep },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, color: c.text, backgroundColor: c.surface, fontSize: 14 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  flex: { flex: 1, minWidth: 0 },
  name: { color: c.text, fontWeight: '800', fontSize: 15 },
  nameLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  verifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 10, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 17, height: 17, borderRadius: 9, overflow: 'hidden' },
  small: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  muted: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: c.danger, fontSize: 12 },
  role: { color: c.accent, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },
});
