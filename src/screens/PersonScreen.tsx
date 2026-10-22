import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { hasProfileLinks, shortWallet, walletAddressOfUserId, type ApiProfile, type ProfileLinks, type ProfileSocial, type PublicCommunityCard } from '@kivo/shared/api/types';
import { openDirectMessage, rememberProfiles } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { api, socialReady } from '../state/session';
import { Avatar } from './ChatListScreen';
import { ProfileLinkChips } from '../components/ProfileLinks';
import { CallStatsCard } from '../components/CallStatsCard';
import { ProfilePostsTimeline } from '../components/ProfilePostsTimeline';

/** Another member's public profile: follow, message, public groups. Display data only — never proof of wallet ownership. */
export function PersonScreen({ userId, onBack, onOpenChat, onOpenCommunity, onOpenConnections }: { userId: string; onBack: () => void; onOpenChat: (id: string) => void; onOpenCommunity: (id: string) => void; onOpenConnections?: (kind: 'followers' | 'following') => void }) {
  const [person, setPerson] = useState<ApiProfile | null>(null);
  const [stats, setStats] = useState<ProfileSocial | null>(null);
  const [groups, setGroups] = useState<PublicCommunityCard[]>([]);
  const [verifiedChannels, setVerifiedChannels] = useState<Set<string>>(() => new Set());
  const [blocked, setBlocked] = useState(false);
  const [postNotifications, setPostNotifications] = useState(false);
  const [postNotificationsLoaded, setPostNotificationsLoaded] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<{isVerified: boolean; expiresAt: number | null; permanent: boolean} | null>(null);
  // EVM (kivo:0x…) or Solana (kivo:sol:…, case-sensitive) account.
  const address = walletAddressOfUserId(userId);
  // Blue Star links: shown only when the server says the profile is verified and has links.
  const [links, setLinks] = useState<ProfileLinks | null>(null);
  useEffect(() => {
    let active = true;
    setLinks(null);
    api.profileLinks(userId).then(result => { if (active && result.verified && hasProfileLinks(result.links)) setLinks(result.links); }).catch(() => {});
    return () => { active = false; };
  }, [userId]);
  useEffect(() => {
    api.profiles([userId]).then(found => { rememberProfiles(found); setPerson(found[0] ?? null); }).catch(() => {});
    api.social(userId).then(setStats).catch(() => {});
    api.publicCommunitiesOf(userId).then(setGroups).catch(() => {});
    api.blockedUsers().then(ids => setBlocked(ids.includes(userId))).catch(() => {});
    let active = true;
    setPostNotificationsLoaded(false);
    if (api.signedInUserId() && api.signedInUserId() !== userId) {
      api.feedPostNotificationSubscription(userId)
        .then(result => { if (active) setPostNotifications(result.enabled); })
        .catch(() => { if (active) setPostNotifications(false); })
        .finally(() => { if (active) setPostNotificationsLoaded(true); });
    } else {
      setPostNotifications(false);
      setPostNotificationsLoaded(true);
    }
    return () => { active = false; };
  }, [userId]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      const channelIds = groups.filter(group => group.kind === 'channel').map(group => group.id);
      void Promise.all(channelIds.map(async id => {
        try { return (await api.verificationStatus('channel', id)).isVerified === true ? id : null; }
        catch { return null; }
      })).then(ids => { if (active) setVerifiedChannels(new Set(ids.filter((id): id is string => Boolean(id)))); });
    };
    setVerifiedChannels(new Set());
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [groups]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      // Badge state comes from the server's verified record, never profile metadata.
      // Ignore late responses after navigating to a different user's profile.
      void api.verificationStatus('profile', userId)
        .then(status => { if (active) setVerificationStatus(status); })
        .catch(() => { if (active) setVerificationStatus(null); });
    };
    setVerificationStatus(null);
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [userId]);
  // Synchronous guard: one action at a time, so a double tap never follows/blocks twice.
  const busyRef = useRef(false);
  const guard = async (fn: () => Promise<void>) => {
    if (!socialReady()) { kivoAlert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    try { await fn(); } catch (e) { kivoAlert('Kivo', e instanceof Error ? e.message : 'Action failed.'); }
    finally { busyRef.current = false; }
  };
  const name = person?.username ? '@' + person.username : shortWallet(address);
  return (
    <View style={styles.root}>
      <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.headerTitle}>Profile</Text></View>
      <ScrollView contentContainerStyle={styles.body}>
        <Avatar name={name} uri={person?.avatarUrl} size={96} verified={verificationStatus?.isVerified === true} />
        <View style={styles.nameLine}><Text style={styles.name}>{name}</Text>{verificationStatus?.isVerified === true ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verifiedBadge}>★</Text> : null}</View>
        {verificationStatus?.isVerified ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verificationBadge}>★ Blue Star Verified</Text> : null}
        {person?.bio ? <Text style={styles.bio}>{person.bio}</Text> : null}
        {links ? <ProfileLinkChips links={links} /> : null}
        <Text style={styles.address}>{address.slice(0, 10)}…{address.slice(-8)}</Text>
        <View style={styles.stats}>
          <Stat value={stats?.following} label="Following" onPress={() => onOpenConnections?.('following')} />
          <Stat value={stats?.followers} label="Followers" onPress={() => onOpenConnections?.('followers')} />
          <Stat value={stats?.groups} label="Groups" />
        </View>
        <View style={styles.actions}>
          <Pressable onPress={() => guard(async () => setStats(stats?.isFollowing ? await api.unfollow(userId) : await api.follow(userId)))} style={[styles.button, stats?.isFollowing ? styles.secondary : styles.primary]}>
            <Text style={stats?.isFollowing ? styles.secondaryText : styles.primaryText}>{stats?.isFollowing ? 'Following' : 'Follow'}</Text>
          </Pressable>
          <Pressable onPress={() => guard(async () => onOpenChat(await openDirectMessage(person?.address ?? address)))} style={[styles.button, styles.secondary]}><Text style={styles.secondaryText}>Message</Text></Pressable>
        </View>
        {api.signedInUserId() && api.signedInUserId() !== userId ? (
          <Pressable disabled={!postNotificationsLoaded} onPress={() => guard(async () => {
            const next = !postNotifications;
            const result = await api.setFeedPostNotificationSubscription(userId, next);
            setPostNotifications(result.enabled);
          })} style={[styles.button, styles.secondary, { alignSelf: 'stretch', flex: 0, opacity: postNotificationsLoaded ? 1 : 0.55 }]}>
            <Text style={styles.secondaryText}>{!postNotificationsLoaded ? 'Loading post notifications…' : postNotifications ? '🔔 Post notifications on' : '♧ Notify me when they post'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => kivoAlert(blocked ? 'Unblock user?' : 'Block user?', blocked ? 'This user is currently blocked. Unblocking will let them message you again.' : 'This user is not blocked. Blocking will stop them from sending you direct messages.', [
          { text: 'Cancel', style: 'cancel' },
          { text: blocked ? 'Unblock user' : 'Block user', style: blocked ? 'default' : 'destructive', onPress: () => guard(async () => { if (blocked) await api.unblockUser(userId); else await api.blockUser(userId); setBlocked(!blocked); }) },
        ])} style={[styles.button, styles.blockButton, blocked && styles.blockedButton]}><Text style={[styles.blockButtonText, blocked && styles.blockedButtonText]}>{blocked ? 'Blocked · Tap to unblock' : 'Block user'}</Text></Pressable>
        <CallStatsCard loadKey={userId} load={() => api.userCalls(userId)} />
        <Text style={styles.note}>Usernames, avatars and follower counts are social signals — never proof of who owns a wallet.</Text>
        <Text style={styles.section}>Joined groups</Text>
        {groups.length === 0 ? <Text style={styles.note}>No public groups yet.</Text> : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {groups.map(g => { const verified = g.kind === 'channel' && verifiedChannels.has(g.id); return <Pressable key={g.id} onPress={() => onOpenCommunity(g.id)} style={styles.tile}><Avatar name={g.name} uri={g.avatarUrl} size={40} verified={verified} /><View style={styles.tileNameLine}><Text style={styles.tileName} numberOfLines={1}>{g.name}</Text>{verified ? <Text accessibilityLabel="Verified community" style={styles.verifiedBadge}>★</Text> : null}</View><Text style={styles.note}>{g.memberCount} {g.kind === 'channel' ? 'subscribers' : 'members'}</Text></Pressable>; })}
          </ScrollView>
        )}
        <ProfilePostsTimeline userId={userId} />
      </ScrollView>
    </View>
  );
}

function Stat({ value, label, onPress }: { value: number | undefined; label: string; onPress?: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} style={styles.stat}><Text style={styles.statValue}>{value ?? '–'}</Text><Text style={styles.statLabel}>{label}</Text></Pressable>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  body: { padding: 20, alignItems: 'center', gap: 10, paddingBottom: 40 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 11, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 18, height: 18, borderRadius: 9, overflow: 'hidden' },
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
  tileNameLine: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 150 },
  tileName: { color: c.text, fontWeight: '800' },
});
