import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
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
  const [menuOpen, setMenuOpen] = useState(false);
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
  const shareProfile = async () => {
    try {
      await Share.share({ message: `Check out ${name} on Kivo${person?.username ? `: https://kivotrade.site/@${encodeURIComponent(person.username)}` : ''}` });
    } catch {
      kivoAlert('Kivo', 'Could not share this profile.');
    }
  };
  const confirmBlock = () => kivoAlert(
    blocked ? 'Unblock user?' : 'Block user?',
    blocked ? 'This user is currently blocked. Unblocking will let them message you again.' : 'This user is not blocked. Blocking will stop them from sending you direct messages.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: blocked ? 'Unblock user' : 'Block user', style: blocked ? 'default' : 'destructive', onPress: () => guard(async () => { if (blocked) await api.unblockUser(userId); else await api.blockUser(userId); setBlocked(!blocked); setMenuOpen(false); }) },
    ],
  );
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={styles.backButton}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.profileCard}>
          <View style={styles.profileTop}>
            <Avatar name={name} uri={person?.avatarUrl} size={58} verified={verificationStatus?.isVerified === true} />
            <Pressable onPress={() => setMenuOpen(open => !open)} accessibilityRole="button" accessibilityLabel="Profile options" accessibilityState={{ expanded: menuOpen }} style={styles.menuButton}>
              <Text style={styles.menuGlyph}>•••</Text>
            </Pressable>
            {menuOpen ? (
              <View style={styles.overflowMenu}>
                <Pressable onPress={() => { setMenuOpen(false); void shareProfile(); }} style={styles.menuItem}><Text style={styles.menuText}>↗  Share profile</Text></Pressable>
                {api.signedInUserId() && api.signedInUserId() !== userId ? (
                  <Pressable disabled={!postNotificationsLoaded} onPress={() => { setMenuOpen(false); void guard(async () => {
                    const next = !postNotifications;
                    const result = await api.setFeedPostNotificationSubscription(userId, next);
                    setPostNotifications(result.enabled);
                  }); }} style={styles.menuItem}><Text style={styles.menuText}>{postNotifications ? '♧  Turn off post notifications' : '♧  Turn on post notifications'}</Text></Pressable>
                ) : null}
                <View style={styles.menuDivider} />
                <Pressable onPress={confirmBlock} style={styles.menuItem}><Text style={styles.menuDanger}>{blocked ? '⊘  Unblock user' : '⊘  Block user'}</Text></Pressable>
              </View>
            ) : null}
          </View>
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
          <View style={styles.joinedMeta}>
            <Text style={styles.joinedMetaText}>›  Joined {person?.createdAt ? new Date(person.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Kivo'}</Text>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={() => guard(async () => setStats(stats?.isFollowing ? await api.unfollow(userId) : await api.follow(userId)))} style={[styles.button, stats?.isFollowing ? styles.secondary : styles.primary]}>
              <Text style={stats?.isFollowing ? styles.secondaryText : styles.primaryText}>{stats?.isFollowing ? 'Following' : 'Follow'}</Text>
            </Pressable>
            <Pressable onPress={() => guard(async () => onOpenChat(await openDirectMessage(person?.address ?? address)))} style={[styles.button, styles.secondary]}><Text style={styles.secondaryText}>Message</Text></Pressable>
            {api.signedInUserId() && api.signedInUserId() !== userId ? (
              <Pressable disabled={!postNotificationsLoaded} onPress={() => guard(async () => {
                const next = !postNotifications;
                const result = await api.setFeedPostNotificationSubscription(userId, next);
                setPostNotifications(result.enabled);
              })} accessibilityRole="button" accessibilityLabel={postNotifications ? 'Turn off post notifications' : 'Turn on post notifications'} style={[styles.notifyButton, { opacity: postNotificationsLoaded ? 1 : 0.55 }]}>
                <Text style={styles.notifyGlyph}>{postNotifications ? '♧' : '♧'}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
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

function Stat({ value, label, onPress }: { value: number | undefined; label: string; onPress?: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} style={styles.stat}><Text style={styles.statValue}>{value ?? '–'}</Text><Text style={styles.statLabel}>{label}</Text></Pressable>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 30, paddingHorizontal: 12, paddingTop: 0, paddingBottom: 0, flexDirection: 'row', alignItems: 'center' },
  backButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  back: { color: c.cream, fontSize: 26, lineHeight: 30, width: 24, textAlign: 'left' },
  body: { paddingHorizontal: 14, paddingTop: 0, alignItems: 'stretch', gap: 8, paddingBottom: 40 },
  profileCard: { alignItems: 'stretch', gap: 8, padding: 12, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  profileTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', minHeight: 38, position: 'relative', zIndex: 2 },
  menuButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  menuGlyph: { color: c.text, fontSize: 16, fontWeight: '900', letterSpacing: 1 },
  overflowMenu: { position: 'absolute', top: 40, right: 0, width: 238, padding: 6, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, zIndex: 20, elevation: 8 },
  menuItem: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9 },
  menuText: { color: c.text, fontSize: 13, fontWeight: '700' },
  menuDanger: { color: c.danger, fontSize: 13, fontWeight: '800' },
  menuDivider: { height: 1, backgroundColor: c.border, marginHorizontal: 6, marginVertical: 4 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  verifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 11, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 18, height: 18, borderRadius: 5, overflow: 'hidden' },
  name: { color: c.text, fontSize: 22, fontWeight: '800' },
  verificationBadge: { color: '#C9F7A6', fontSize: 11, fontWeight: '900', textAlign: 'left', alignSelf: 'flex-start', backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: '#C9F7A6', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  bio: { color: c.text, fontSize: 14, textAlign: 'left' },
  address: { color: c.textMuted, fontSize: 12, alignSelf: 'flex-start', borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  joinedMeta: { alignSelf: 'flex-start', paddingTop: 1 },
  joinedMetaText: { color: c.textMuted, fontSize: 12 },
  stats: { flexDirection: 'row', alignSelf: 'stretch', backgroundColor: 'transparent', borderRadius: 0, borderWidth: 0, paddingVertical: 3, marginTop: 0 },
  stat: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 3 },
  statValue: { color: c.text, fontSize: 14, fontWeight: '800' },
  statLabel: { color: c.textMuted, fontSize: 13, marginTop: 0 },
  actions: { flexDirection: 'row', gap: 8, alignSelf: 'stretch', marginTop: 2 },
  button: { flex: 1, height: 40, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: c.cream },
  primaryText: { color: c.backgroundDeep, fontWeight: '900' },
  secondary: { backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  secondaryText: { color: c.text, fontWeight: '800' },
  notifyButton: { width: 42, height: 40, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  notifyGlyph: { color: c.text, fontSize: 18, fontWeight: '800' },
  note: { color: c.textMuted, fontSize: 11.5, textAlign: 'center' },
  section: { alignSelf: 'flex-start', color: c.text, fontSize: 17, fontWeight: '800', marginTop: 12 },
  strip: { gap: 10 },
  tile: { width: 140, padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 6 },
  tileNameLine: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 150 },
  tileName: { color: c.text, fontWeight: '800' },
});
