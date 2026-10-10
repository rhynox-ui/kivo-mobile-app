import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { type ApiCommunity, type ApiConversation, type ApiProfile } from '@kivo/shared/api/types';
import { displayName, myUserId, openDirectMessage, rememberProfiles, unreadCount } from '@kivo/shared/chat/store';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';
import { api, enableSocial, useSocialReady } from '../state/session';
import { useChatState } from '../state/useChat';
import { getWalletSession } from '../state/walletStore';
import { refreshConversations } from '@kivo/shared/chat/store';

type Filter = 'all' | 'dm' | 'group' | 'channel';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['dm', 'Chats'], ['group', 'Groups'], ['channel', 'Channels']];

function timeLabel(ts: number) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ChatListScreen({ onOpenChat, onOpenCommunities, onOpenNotifications }: {
  onOpenChat: (id: string) => void;
  onOpenCommunities?: () => void;
  onOpenNotifications?: () => void;
}) {
  const ready = useSocialReady();
  const state = useChatState();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [publicChannels, setPublicChannels] = useState<ApiCommunity[]>([]);

  // Subscription expiry is time-based, so refresh server-authoritative badge
  // status periodically while the chat list is open and when the app resumes.
  useEffect(() => {
    const refresh = () => { void refreshConversations().catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.conversations.filter(c => (filter === 'all' || c.kind === filter) && (!q || c.title.toLowerCase().includes(q)));
  }, [state.conversations, filter, query]);

  useEffect(() => {
    if (filter !== 'channel' || !ready) { setPublicChannels([]); return; }
    let active = true;
    api.discover('channel', query.trim()).then(found => {
      if (!active) return;
      const joined = new Set(state.conversations.filter(c => c.kind === 'channel').map(c => c.id));
      setPublicChannels(found.filter(c => !joined.has(c.id)));
    }).catch(() => { if (active) setPublicChannels([]); });
    return () => { active = false; };
  }, [filter, query, ready, state.conversations]);

  if (!ready) return <EnableSocial />;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.brand}><KivoMark size={30} /><Text style={styles.brandText}>kivo</Text></View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => setComposing(v => !v)} hitSlop={8} accessibilityLabel="New message"><Text style={styles.headerIcon}>✎</Text></Pressable>
          {onOpenCommunities && <Pressable onPress={onOpenCommunities} hitSlop={8} accessibilityLabel="Communities"><Text style={styles.headerIcon}>👥</Text></Pressable>}
          {onOpenNotifications && <Pressable onPress={onOpenNotifications} hitSlop={8} accessibilityLabel="Notifications"><Text style={styles.headerIcon}>🔔</Text></Pressable>}
        </View>
      </View>
      {composing && <NewChat onOpen={id => { setComposing(false); onOpenChat(id); }} />}
      <View style={styles.search}><Text style={styles.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search chats" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.searchInput} /></View>
      <View style={styles.filters}>
        {FILTERS.map(([value, label]) => (
          <Pressable key={value} onPress={() => setFilter(value)} style={[styles.filter, filter === value && styles.filterActive]}>
            <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {!state.online && <Text style={styles.offline}>Offline — showing messages saved on this phone.</Text>}
      <FlatList
        data={list}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <Row conversation={item} onPress={() => onOpenChat(item.id)} />}
        ListEmptyComponent={filter === 'channel' && publicChannels.length ? undefined : <View style={styles.empty}><Text style={styles.emptyTitle}>{filter === 'channel' ? 'No channels yet' : 'No chats yet'}</Text><Text style={styles.muted}>Discover public channels or join communities to see them here.</Text></View>}
        ListFooterComponent={filter === 'channel' && publicChannels.length ? <View style={styles.discoverSection}>
          {publicChannels.map(c => <Pressable key={c.id} style={styles.row} onPress={async () => {
            try { await api.join(c.id); await refreshConversations().catch(() => {}); onOpenChat(c.id); }
            catch (e) { Alert.alert(c.name, e instanceof Error ? e.message : 'Unable to subscribe to channel.'); }
          }}>
            <Avatar name={c.name} uri={c.avatarUrl} size={52} verified={c.isVerified === true} />
            <View style={styles.rowMain}><View style={styles.rowTop}><Text style={styles.rowTitle} numberOfLines={1}>📢 {c.name}{(c.isVerified) ? ' ★' : ''}</Text></View><Text style={styles.preview}>Public channel · Tap to subscribe</Text></View>
          </Pressable>)}
        </View> : undefined}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function Row({ conversation: c, onPress }: { conversation: ApiConversation; onPress: () => void }) {
  const unread = unreadCount(c.id);
  const [peerVerified, setPeerVerified] = useState(false);
  useEffect(() => {
    let active = true;
    const check = () => {
      if (c.kind !== 'dm' || !c.peer?.userId) {
        setPeerVerified(false);
        return;
      }
      void api.verificationStatus('profile', c.peer.userId)
        .then(status => { if (active) setPeerVerified(status.isVerified === true); })
        .catch(() => { if (active) setPeerVerified(false); });
    };
    setPeerVerified(false);
    check();
    // Verification can expire or be revoked while this row remains mounted.
    const timer = setInterval(check, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') check();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [c.id, c.kind, c.peer?.userId]);
  // A DM's cached conversation flag must never override the live profile
  // status: the avatar shape and star use the exact same verified boolean.
  const verified = c.kind === 'dm' ? peerVerified : c.isVerified === true;
  const me = myUserId();
  const prefix = c.lastSenderId && c.kind !== 'channel' && c.lastPreview ? (c.lastSenderId === me ? 'You: ' : c.kind === 'group' ? `${displayName(c.lastSenderId)}: ` : '') : '';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Avatar name={c.title} uri={c.avatarUrl} size={52} verified={verified} />
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <View style={styles.rowTitleLine}><Text style={styles.rowTitle} numberOfLines={1}>{c.kind === 'channel' ? '📢 ' : c.kind === 'group' ? '👥 ' : ''}{c.title}</Text>{c.kind === 'dm' && peerVerified ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verifiedBadge}>★</Text> : null}{c.kind !== 'dm' && (c.isVerified === true) ? <Text accessibilityLabel="Verified community" style={styles.verifiedBadge}>★</Text> : null}</View>
          <Text style={[styles.time, unread > 0 && styles.timeUnread]}>{timeLabel(c.lastActivityAt)}</Text>
        </View>
        <View style={styles.rowTop}>
          <Text style={styles.preview} numberOfLines={1}>{c.lastPreview ? prefix + c.lastPreview : c.kind === 'dm' ? 'Say hello 👋' : c.kind === 'group' ? 'Group created' : 'Channel'}</Text>
          {unread > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unread > 999 ? '999+' : unread}</Text></View>}
        </View>
      </View>
    </Pressable>
  );
}

export function Avatar({ name, uri, size, verified = false }: { name: string; uri?: string | null; size: number; verified?: boolean }) {
  // Callers pass only a server-confirmed verification status.
  const borderRadius = verified ? 6 : size / 2;
  return (
    <View style={{ width: size, height: size, position: 'relative', overflow: 'visible' }}>
      {uri
        ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius, backgroundColor: kivoTheme.colors.surfaceRaised }} />
        : <View style={[styles.avatar, { width: size, height: size, borderRadius }]}><Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{name.replace(/^@/, '').slice(0, 1).toUpperCase()}</Text></View>}
    </View>
  );
}

function NewChatProfileResult({ profile, onPress }: { profile: ApiProfile; onPress: () => void }) {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    let active = true;
    api.verificationStatus('profile', profile.userId).then(status => { if (active) setVerified(status.isVerified === true); }).catch(() => { if (active) setVerified(false); });
    return () => { active = false; };
  }, [profile.userId]);
  return (
    <Pressable onPress={onPress} style={styles.result}>
      <Avatar name={profile.username ?? profile.address} uri={profile.avatarUrl} size={34} verified={verified} />
      <View style={{ flex: 1 }}>
        <View style={styles.resultTitleLine}><Text style={styles.resultTitle}>{profile.username ? '@' + profile.username : profile.address}</Text>{verified ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verifiedBadge}>★</Text> : null}</View>
        {profile.bio ? <Text style={styles.muted} numberOfLines={1}>{profile.bio}</Text> : null}
      </View>
    </Pressable>
  );
}

function NewChat({ onOpen }: { onOpen: (id: string) => void }) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState<ApiProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const search = async (q: string) => {
    setValue(q);
    if (q.trim().length < 2 || /^0x/i.test(q.trim())) { setResults([]); return; }
    try { const found = await api.searchProfiles(q.trim()); rememberProfiles(found); setResults(found); } catch { setResults([]); }
  };
  const start = async (address: string) => {
    setBusy(true);
    try { onOpen(await openDirectMessage(address)); }
    catch (error) { Alert.alert('New message', error instanceof Error ? error.message : 'Could not start chat.'); }
    finally { setBusy(false); }
  };
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(value.trim());
  return (
    <View style={styles.newChat}>
      <TextInput value={value} onChangeText={search} autoFocus autoCapitalize="none" autoCorrect={false} placeholder="@username or 0x wallet address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.newChatInput} />
      {busy && <ActivityIndicator color={kivoTheme.colors.accent} />}
      {isAddress && <Pressable onPress={() => start(value.trim())} style={styles.result}><Text style={styles.resultTitle}>Message {value.trim().slice(0, 6)}…{value.trim().slice(-4)}</Text></Pressable>}
      {results.filter(p => p.address.toLowerCase() !== getWalletSession()?.address.toLowerCase()).map(p => (
        <NewChatProfileResult key={p.userId} profile={p} onPress={() => start(p.address)} />
      ))}
    </View>
  );
}

export function EnableSocial() {
  const [busy, setBusy] = useState(false);
  const wallet = getWalletSession();
  const turnOn = async () => {
    setBusy(true);
    try { await enableSocial(); }
    catch (error) { Alert.alert('Kivo chats', error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };
  return (
    <View style={styles.enable}>
      <KivoMark size={72} />
      <Text style={styles.enableTitle}>Turn on Kivo chats</Text>
      <Text style={styles.enableBody}>Sign a short message with your wallet to prove it’s you. It is free, it is not a transaction and it cannot move funds.</Text>
      <Text style={styles.enablePoint}>🔒  Your chat history is stored on this phone.</Text>
      <Text style={styles.enablePoint}>✓  Kivo only relays messages and keeps them 30 days.</Text>
      <Text style={styles.enablePoint}>🛡  Your username is display only — your wallet is your identity.</Text>
      <Pressable disabled={busy || wallet?.source !== 'local'} onPress={turnOn} style={[styles.enableButton, (busy || wallet?.source !== 'local') && styles.disabled]}>
        <Text style={styles.enableButtonText}>{busy ? 'Signing…' : 'Turn on chats'}</Text>
      </Pressable>
      {wallet?.source !== 'local' && <Text style={styles.muted}>A watch-only address cannot sign. Create or import a wallet on this phone.</Text>}
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { color: c.cream, fontSize: 28, fontWeight: '800', letterSpacing: -1 },
  headerActions: { flexDirection: 'row', gap: 18 },
  headerIcon: { color: c.text, fontSize: 21 },
  search: { marginHorizontal: 16, height: 44, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  searchIcon: { color: c.textMuted, fontSize: 20 },
  searchInput: { flex: 1, color: c.text, marginLeft: 6, fontSize: 14 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  filter: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  filterActive: { backgroundColor: '#2FD67B', borderColor: '#2FD67B' },
  filterText: { color: c.textMuted, fontSize: 12.5, fontWeight: '700' },
  filterTextActive: { color: c.backgroundDeep },
  offline: { color: '#F2C96D', fontSize: 12, paddingHorizontal: 18, paddingBottom: 6 },
  listContent: { paddingBottom: 24 },
  discoverSection: { borderTopWidth: 1, borderTopColor: c.border, marginTop: 12, paddingTop: 12 },
  discoverTitle: { color: c.text, fontSize: 15, fontWeight: '800', paddingHorizontal: 16, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  pressed: { backgroundColor: c.surface },
  rowMain: { flex: 1, minWidth: 0, gap: 4, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 10 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowTitleLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowTitle: { color: c.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  verifiedBadge: { overflow: 'hidden', color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 11, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 17, height: 17, borderRadius: 9 },
  time: { color: c.textMuted, fontSize: 11.5 },
  timeUnread: { color: '#2FD67B', fontWeight: '700' },
  preview: { color: c.textMuted, fontSize: 13.5, flex: 1 },
  badge: { minWidth: 24, height: 24, borderRadius: 999, paddingHorizontal: 7, backgroundColor: '#40566A', alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#F4F8FC', fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  avatar: { backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.cream, fontWeight: '800' },
  empty: { alignItems: 'center', padding: 30, gap: 6 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  muted: { color: c.textMuted, fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
  newChat: { marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 8 },
  newChatInput: { color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.backgroundDeep },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  resultTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  resultTitle: { color: c.text, fontWeight: '700' },
  enable: { flex: 1, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  enableTitle: { color: c.text, fontSize: 24, fontWeight: '800', marginTop: 8 },
  enableBody: { color: c.textMuted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  enablePoint: { color: c.text, fontSize: 13, alignSelf: 'stretch' },
  enableButton: { alignSelf: 'stretch', marginTop: 10, height: 54, borderRadius: 27, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  enableButtonText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 16 },
  disabled: { opacity: 0.45 },
});
