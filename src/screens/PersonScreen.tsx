import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiProfile, ProfileSocial, PublicCommunityCard } from '@kivo/shared/api/types';
import { openDirectMessage, rememberProfiles } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { api, socialReady } from '../state/session';
import { Avatar } from './ChatListScreen';

/** Another member's public profile: follow, message, public groups. Display data only — never proof of wallet ownership. */
export function PersonScreen({ userId, onBack, onOpenChat, onOpenCommunity }: { userId: string; onBack: () => void; onOpenChat: (id: string) => void; onOpenCommunity: (id: string) => void }) {
  const [person, setPerson] = useState<ApiProfile | null>(null);
  const [stats, setStats] = useState<ProfileSocial | null>(null);
  const [groups, setGroups] = useState<PublicCommunityCard[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<{isVerified: boolean; expiresAt: number | null; permanent: boolean} | null>(null);
  const address = userId.replace(/^kivo:/, '');
  useEffect(() => {
    api.profiles([userId]).then(found => { rememberProfiles(found); setPerson(found[0] ?? null); }).catch(() => {});
    api.social(userId).then(setStats).catch(() => {});
    api.publicCommunitiesOf(userId).then(setGroups).catch(() => {});
    api.blockedUsers().then(ids => setBlocked(ids.includes(userId))).catch(() => {});
  }, [userId]);
  useEffect(() => {
    let active = true;
    setVerificationStatus(null);
    // Badge state comes from the server's verified record, never profile metadata.
    // Ignore late responses after navigating to a different user's profile.
    api.verificationStatus('profile', userId)
      .then(status => { if (active) setVerificationStatus(status); })
      .catch(() => { if (active) setVerificationStatus(null); });
    return () => { active = false; };
  }, [userId]);
  const guard = async (fn: () => Promise<void>) => {
    if (!socialReady()) { Alert.alert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    try { await fn(); } catch (e) { Alert.alert('Kivo', e instanceof Error ? e.message : 'Action failed.'); }
  };
  const name = person?.username ? '@' + person.username : `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <View style={styles.root}>
      <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.headerTitle}>Profile</Text></View>
      <ScrollView contentContainerStyle={styles.body}>
        <Avatar name={name} uri={person?.avatarUrl} size={96} />
        <Text style={styles.name}>{name}</Text>
        {verificationStatus?.isVerified ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verificationBadge}>★ Blue Star Verified · {verificationStatus.permanent || !verificationStatus.expiresAt ? 'permanent' : `valid until ${new Date(verificationStatus.expiresAt).toLocaleDateString()}`}</Text> : null}
        {person?.bio ? <Text style={styles.bio}>{person.bio}</Text> : null}
        <Text style={styles.address}>{address.slice(0, 10)}…{address.slice(-8)}</Text>
        <View style={styles.stats}>
          <Stat value={stats?.following} label="Following" />
          <Stat value={stats?.followers} label="Followers" />
          <Stat value={stats?.groups} label="Groups" />
        </View>
        <View style={styles.actions}>
          <Pressable onPress={() => guard(async () => setStats(stats?.isFollowing ? await api.unfollow(userId) : await api.follow(userId)))} style={[styles.button, stats?.isFollowing ? styles.secondary : styles.primary]}>
            <Text style={stats?.isFollowing ? styles.secondaryText : styles.primaryText}>{stats?.isFollowing ? 'Following' : 'Follow'}</Text>
          </Pressable>
          <Pressable onPress={() => guard(async () => onOpenChat(await openDirectMessage(address)))} style={[styles.button, styles.secondary]}><Text style={styles.secondaryText}>Message</Text></Pressable>
        </View>
        <Pressable onPress={() => Alert.alert(blocked ? 'Unblock user?' : 'Block user?', blocked ? 'This user is currently blocked. Unblocking will let them message you again.' : 'This user is not blocked. Blocking will stop them from sending you direct messages.', [
          { text: 'Cancel', style: 'cancel' },
          { text: blocked ? 'Unblock user' : 'Block user', style: blocked ? 'default' : 'destructive', onPress: () => guard(async () => { if (blocked) await api.unblockUser(userId); else await api.blockUser(userId); setBlocked(!blocked); }) },
        ])} style={[styles.button, styles.blockButton, blocked && styles.blockedButton]}><Text style={[styles.blockButtonText, blocked && styles.blockedButtonText]}>{blocked ? 'Blocked · Tap to unblock' : 'Block user'}</Text></Pressable>
        <Text style={styles.note}>Usernames, avatars and follower counts are social signals — never proof of who owns a wallet.</Text>
        <Text style={styles.section}>Joined groups</Text>
        {groups.length === 0 ? <Text style={styles.note}>No public groups yet.</Text> : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {groups.map(g => <Pressable key={g.id} onPress={() => onOpenCommunity(g.id)} style={styles.tile}><Avatar name={g.name} uri={g.avatarUrl} size={40} /><Text style={styles.tileName} numberOfLines={1}>{g.name}</Text><Text style={styles.note}>{g.memberCount} {g.kind === 'channel' ? 'subscribers' : 'members'}</Text></Pressable>)}
          </ScrollView>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value ?? '–'}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  body: { padding: 20, alignItems: 'center', gap: 10, paddingBottom: 40 },
  name: { color: c.text, fontSize: 26, fontWeight: '800' },
  verificationBadge: { color: '#C9F7A6', fontSize: 12, fontWeight: '900', textAlign: 'center', backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: '#C9F7A6', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  bio: { color: c.text, fontSize: 14, textAlign: 'center' },
  address: { color: c.textMuted, fontSize: 12 },
  stats: { flexDirection: 'row', alignSelf: 'stretch', backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, paddingVertical: 12, marginTop: 6 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: c.text, fontSize: 18, fontWeight: '800' },
  statLabel: { color: c.textMuted, fontSize: 11, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 10, alignSelf: 'stretch' },
  button: { flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: c.cream },
  primaryText: { color: c.backgroundDeep, fontWeight: '900' },
  secondary: { backgroundColor: c.surfaceRaised },
  secondaryText: { color: c.text, fontWeight: '800' },
  blockButton: { alignSelf: 'stretch', backgroundColor: c.surface, borderWidth: 1, borderColor: c.danger },
  blockButtonText: { color: c.danger, fontWeight: '800' },
  blockedButton: { backgroundColor: '#3B2026', borderColor: c.danger },
  blockedButtonText: { color: '#FF9A9A', fontWeight: '900' },
  note: { color: c.textMuted, fontSize: 11.5, textAlign: 'center' },
  section: { alignSelf: 'flex-start', color: c.text, fontSize: 17, fontWeight: '800', marginTop: 12 },
  strip: { gap: 10 },
  tile: { width: 140, padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 6 },
  tileName: { color: c.text, fontWeight: '800' },
});
