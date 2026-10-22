import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { ApiProfile } from '@kivo/shared/api/types';
import type { FollowListPage } from '@kivo/shared/api/client';
import { api, socialReady } from '../state/session';
import { Avatar } from './ChatListScreen';
import { kivoTheme } from '../theme/kivoTheme';

type Kind = 'verified' | 'known' | 'followers' | 'following';
const TABS: {key: Kind; label: string}[] = [
  {key: 'verified', label: 'Verified followers'},
  {key: 'known', label: 'Followers you know'},
  {key: 'followers', label: 'Followers'},
  {key: 'following', label: 'Following'},
];

/** X-style profile connections, using Kivo's existing social API and avatar components. */
export function ConnectionsScreen({userId, initialKind, onBack, onOpenPerson}: {
  userId: string;
  initialKind: 'followers' | 'following' | 'known';
  onBack: () => void;
  onOpenPerson: (userId: string) => void;
}) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [users, setUsers] = useState<ApiProfile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState<Record<string, boolean>>({});
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (reset = true) => {
    const id = ++requestId.current;
    if (reset) { setLoading(true); setError(''); setCursor(null); }
    else setLoadingMore(true);
    try {
      const next = reset ? null : cursor;
      let page: FollowListPage;
      if (kind === 'known') page = await api.knownFollowers(userId, next);
      else if (kind === 'following') page = await api.following(userId, next);
      else page = await api.followers(userId, next);
      if (id !== requestId.current) return;
      const incoming = page.users;
      const verifiedPairs = await Promise.all(incoming.map(async person => {
        try { return [person.userId, (await api.verificationStatus('profile', person.userId)).isVerified === true] as const; }
        catch { return [person.userId, false] as const; }
      }));
      if (id !== requestId.current) return;
      setVerified(old => {
        const nextSet = reset ? new Set<string>() : new Set(old);
        verifiedPairs.forEach(([id, yes]) => { if (yes) nextSet.add(id); else nextSet.delete(id); });
        return nextSet;
      });
      const visible = kind === 'verified' ? incoming.filter(p => verifiedPairs.some(([id, yes]) => id === p.userId && yes)) : incoming;
      setUsers(old => reset ? visible : [...old, ...visible.filter(p => !old.some(existing => existing.userId === p.userId))]);
      setCursor(page.nextCursor);
      const statuses = await Promise.all(incoming.map(async person => {
        try { return [person.userId, (await api.social(person.userId)).isFollowing] as const; }
        catch { return [person.userId, false] as const; }
      }));
      if (id === requestId.current) setFollowing(old => ({...(reset ? {} : old), ...Object.fromEntries(statuses)}));
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : 'Could not load accounts. Try again.');
    } finally {
      if (id === requestId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [cursor, kind, userId]);

  useEffect(() => { setUsers([]); setVerified(new Set()); setFollowing({}); void load(true); }, [kind, userId]); // load is intentionally triggered by tab/profile changes.

  const changeFollow = async (person: ApiProfile) => {
    if (!socialReady()) { setError('Turn on chats first to follow accounts.'); return; }
    if (busyUser) return;
    setBusyUser(person.userId);
    try {
      const result = following[person.userId] ? await api.unfollow(person.userId) : await api.follow(person.userId);
      setFollowing(old => ({...old, [person.userId]: result.isFollowing}));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update follow. Try again.'); }
    finally { setBusyUser(null); }
  };

  const renderPerson = ({item}: {item: ApiProfile}) => {
    const isVerified = verified.has(item.userId);
    const name = item.username ? '@' + item.username : item.address.slice(0, 7) + '…' + item.address.slice(-5);
    const isFollowing = following[item.userId] === true;
    return <View style={styles.row}>
      <Pressable style={styles.identity} onPress={() => onOpenPerson(item.userId)} accessibilityRole="button" accessibilityLabel={'Open ' + name + ' profile'}>
        <Avatar name={name} uri={item.avatarUrl} size={48} verified={isVerified} />
        <View style={styles.copy}>
          <View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{item.username || name}</Text>{isVerified ? <Text accessibilityLabel="Blue Star verified" style={styles.badge}>★</Text> : null}</View>
          {item.username ? <Text style={styles.handle} numberOfLines={1}>@{item.username}</Text> : null}
          {!!item.bio && <Text style={styles.bio} numberOfLines={3}>{item.bio}</Text>}
        </View>
      </Pressable>
      {api.signedInUserId() !== item.userId ? <Pressable disabled={busyUser === item.userId} onPress={() => void changeFollow(item)} style={[styles.followButton, isFollowing && styles.followingButton]}>
        <Text style={[styles.followText, isFollowing && styles.followingText]}>{busyUser === item.userId ? '…' : isFollowing ? 'Following' : 'Follow'}</Text>
      </Pressable> : null}
    </View>;
  };

  return <View style={styles.root}>
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back"><Text style={styles.back}>‹</Text></Pressable>
      <View><Text style={styles.title}>Connections</Text><Text style={styles.subtitle}>@{userId.startsWith('kivo:') ? 'Kivo user' : userId}</Text></View>
    </View>
    <View style={styles.tabs}>{TABS.map(tab => <Pressable key={tab.key} onPress={() => setKind(tab.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{selected: kind === tab.key}}><Text style={[styles.tabText, kind === tab.key && styles.tabActive]}>{tab.label}</Text>{kind === tab.key ? <View style={styles.underline}/> : null}</Pressable>)}</View>
    {error ? <Pressable onPress={() => void load(true)} style={styles.error}><Text style={styles.errorText}>{error} · Tap to retry</Text></Pressable> : null}
    {loading ? <View style={styles.center}><ActivityIndicator color={c.accent}/><Text style={styles.muted}>Loading accounts…</Text></View> :
      <FlatList data={users} keyExtractor={item => item.userId} renderItem={renderPerson} contentContainerStyle={users.length ? styles.list : styles.emptyList}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load(true)} tintColor={c.accent}/>}
        ListEmptyComponent={<Text style={styles.muted}>{kind === 'verified' ? 'No verified followers found.' : kind === 'known' ? 'No followers you know yet.' : 'No accounts to show yet.'}</Text>}
        ListFooterComponent={cursor ? <Pressable disabled={loadingMore} onPress={() => void load(false)} style={styles.more}>{loadingMore ? <ActivityIndicator color={c.accent}/> : <Text style={styles.moreText}>Load more</Text>}</Pressable> : undefined}/>}
  </View>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: c.background},
  header: {minHeight: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12},
  back: {color: c.text, fontSize: 36, width: 24, lineHeight: 40},
  title: {color: c.text, fontSize: 19, fontWeight: '900'},
  subtitle: {color: c.textMuted, fontSize: 12, maxWidth: 270},
  tabs: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border},
  tab: {flex: 1, minWidth: 0, minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3},
  tabText: {color: c.textMuted, fontSize: 10, fontWeight: '700', textAlign: 'center'},
  tabActive: {color: c.text},
  underline: {position: 'absolute', bottom: 0, height: 3, width: '70%', borderRadius: 2, backgroundColor: c.accent},
  list: {paddingBottom: 24},
  emptyList: {flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 28},
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border},
  identity: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 11},
  copy: {flex: 1, minWidth: 0, gap: 2},
  nameLine: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5},
  name: {color: c.text, fontSize: 14, fontWeight: '900', flexShrink: 1},
  handle: {color: c.textMuted, fontSize: 12},
  bio: {color: c.text, fontSize: 13, lineHeight: 18, marginTop: 3},
  badge: {color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 10, fontWeight: '900', textAlign: 'center', overflow: 'hidden', borderRadius: 8, width: 16, height: 16},
  followButton: {minWidth: 82, paddingHorizontal: 12, height: 36, borderRadius: 999, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center'},
  followingButton: {backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border},
  followText: {color: c.backgroundDeep, fontSize: 12, fontWeight: '900'},
  followingText: {color: c.text},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10},
  muted: {color: c.textMuted, fontSize: 13, textAlign: 'center'},
  error: {padding: 10, backgroundColor: c.surfaceRaised},
  errorText: {color: c.danger, fontSize: 12},
  more: {alignSelf: 'center', margin: 16, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, backgroundColor: c.surfaceRaised},
  moreText: {color: c.text, fontWeight: '800'},
});
