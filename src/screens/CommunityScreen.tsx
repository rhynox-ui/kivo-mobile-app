import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { hasProfileLinks, normalizeProfileLinks, shortWallet, walletAddressOfUserId, type ApiCommunity, type ApiMember, type GateCheck, type ProfileLinks } from '@kivo/shared/api/types';
import { refreshConversations } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { api, ensureSolanaLinked, socialReady } from '../state/session';
import { CallStatsCard } from '../components/CallStatsCard';
import { gateSummary } from '../components/HolderGate';
import { Avatar } from './ChatListScreen';
import { communityShareLink } from './CommunitySettingsScreen';
import { LinkFields, ProfileLinkChips, linkDraftFrom, type LinkDraft } from '../components/ProfileLinks';

function memberName(member: ApiMember) {
  if (member.profile?.username) return '@' + member.profile.username;
  return shortWallet(walletAddressOfUserId(member.userId));
}

/** Group/channel info: description, members/team and owner-controlled roles (same rules as web and the API). */
export function CommunityScreen({ id, onBack, onOpenChat, onOpenPerson, onOpenVerification, onOpenManage }: { id: string; onBack: () => void; onOpenChat: (id: string) => void; onOpenPerson?: (userId: string) => void; onOpenManage?: (id: string) => void; onOpenVerification?: (subjectType: 'channel', subjectId: string, subjectName: string) => void }) {
  const [data, setData] = useState<{ community: ApiCommunity; members: ApiMember[] } | null>(null);
  const [error, setError] = useState('');
  const [verifiedMembers, setVerifiedMembers] = useState<Set<string>>(() => new Set());
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  // Blue Star links: the server decides eligibility and only returns links while it holds.
  const [links, setLinks] = useState<{ eligible: boolean; links: ProfileLinks } | null>(null);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(() => linkDraftFrom(null));
  const [linksError, setLinksError] = useState('');
  // Synchronous guard: one community action at a time, so a double tap never repeats it.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // Holder gate: the viewer's eligibility, checked before Join (server re-checks on join).
  const [gateCheck, setGateCheck] = useState<GateCheck | null>(null);
  const [gateState, setGateState] = useState<'idle' | 'checking' | 'error'>('idle');
  const [gateError, setGateError] = useState('');
  const gate = data?.community.gate ?? null;
  const gateNeeded = Boolean(gate && !data?.community.myRole);
  const checkGate = useCallback(async (fresh = false) => {
    if (!gate || !socialReady()) return;
    setGateState('checking'); setGateError('');
    try {
      // Solana-token gates read the linked Solana wallet: link it first (one signature, once per account).
      if (gate.chain === 'solana') await ensureSolanaLinked({ interactive: true }).catch(e => { setGateError(e instanceof Error ? e.message : 'Could not link your Solana wallet.'); });
      const result = await api.checkCommunityGate(id, fresh);
      setGateCheck(result); setGateState('idle');
    } catch (e) { setGateCheck(null); setGateState('error'); setGateError(e instanceof Error ? e.message : 'Could not check your balance.'); }
  }, [id, gate?.chain, gate?.address, gate?.minAmount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setGateCheck(null); if (gateNeeded) void checkGate(); }, [gateNeeded, checkGate]);

  const loadLinks = useCallback(() => api.communityLinks(id)
    .then(result => { setLinks(result); setLinkDraft(linkDraftFrom(result.links)); setLinksError(''); })
    .catch(() => setLinksError('Links are unavailable right now.')), [id]);
  useEffect(() => { setLinks(null); void loadLinks(); }, [loadLinks]);

  useEffect(() => {
    let active = true;
    const ids = (data?.members ?? []).map(member => member.userId);
    if (!ids.length) { setVerifiedMembers(new Set()); return () => { active = false; }; }
    void Promise.all(ids.map(async userId => {
      try {
        const status = await api.verificationStatus('profile', userId);
        return status.isVerified ? userId : null;
      } catch { return null; }
    })).then(results => {
      if (active) setVerifiedMembers(new Set(results.filter((id): id is string => Boolean(id))));
    });
    return () => { active = false; };
  }, [data?.members]);

  const load = useCallback(() => api.community(id).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Not available.')), [id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [load]);

  const run = (action: () => Promise<unknown>, done?: () => void) => async () => {
    if (!socialReady()) { kivoAlert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await action(); await refreshConversations().catch(() => {}); done ? done() : void load(); }
    catch (e) { kivoAlert('Community', e instanceof Error ? e.message : 'Action failed.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const saveLinks = run(async () => {
    // Throws a readable message for an invalid link; the server re-validates.
    const next = normalizeProfileLinks(linkDraft);
    const saved = await api.saveCommunityLinks(id, next);
    setLinks(saved);
    setLinkDraft(linkDraftFrom(saved.links));
    kivoAlert('Links', 'Links saved.');
  });

  if (error) return <View style={styles.root}><Header title="Community" onBack={onBack} /><Text style={styles.muted}>{error}</Text></View>;
  if (!data) return <View style={styles.root}><Header title="Community" onBack={onBack} /><ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 40 }} /></View>;

  const { community: c, members } = data;
  const isChannel = c.kind === 'channel';
  const manager = c.myRole === 'owner' || c.myRole === 'admin';
  const shareMessage = `Join ${c.name} on Kivo: ${communityShareLink(c)}`;
  const gateBlocked = gateNeeded && gateCheck?.eligible !== true;

  return (
    <View style={styles.root}>
      <Header title={c.name} verified={Boolean(c.isVerified)} onBack={onBack} onShare={() => Share.share({ message: shareMessage })} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.profileHero}>
          <View style={styles.profileIdentity}>
            <Avatar name={c.name} uri={c.avatarUrl} size={92} verified={c.isVerified === true} />
            <View style={styles.titleLine}><Text style={styles.title}>{c.name}</Text>{(c.isVerified === true) ? <Text accessibilityLabel="Verified community" style={styles.verifiedBadge}>★</Text> : null}</View>
            <Text style={styles.profileSubtitle}>{c.visibility === 'private' ? 'Private' : 'Public'} {isChannel ? 'channel' : 'group'} · {c.memberCount} {isChannel ? 'subscribers' : 'members'}</Text>
            {c.myRole ? <Text style={styles.role}>{c.myRole.toUpperCase()}</Text> : null}
          </View>
          <View style={styles.profileActions}>
            {c.myRole
              ? <Pressable onPress={() => onOpenChat(c.id)} style={styles.actionButton}><Text style={styles.primaryText}>{isChannel ? 'Open channel' : 'Open chat'}</Text></Pressable>
              : <Pressable disabled={busy || gateBlocked} onPress={run(() => api.join(c.id), () => onOpenChat(c.id))} style={[styles.actionButton, gateBlocked && styles.disabled]}><Text style={styles.primaryText}>{c.visibility === 'private' ? 'Private' : isChannel ? 'Subscribe' : 'Join group'}</Text></Pressable>}
            <Pressable onPress={() => Share.share({ message: shareMessage })} style={styles.shareButton}><Text style={styles.shareButtonText}>Share</Text></Pressable>
          </View>
          {c.gate ? <View style={styles.gateBox}>
            <Text style={styles.gateTitle}>{gateSummary(c.gate)}</Text>
            {!c.myRole ? (!socialReady() ? <Text style={styles.small}>Turn on chats to check your balance.</Text>
              : gateState === 'checking' ? <ActivityIndicator color={kivoTheme.colors.accent} />
              : gateCheck ? <Text style={[styles.small, gateCheck.eligible ? styles.gateOk : styles.gateNo]}>{gateCheck.eligible ? `✓ You hold ${gateCheck.balance ?? 'enough'} $${c.gate.symbol} — you can ${isChannel ? 'subscribe' : 'join'}.` : !gateCheck.wallet ? (c.gate.chain === 'solana' ? 'Link your Solana wallet to check your balance.' : 'Your account has no wallet on this network.') : `You hold ${gateCheck.balance ?? '0'} $${c.gate.symbol} — need at least ${c.gate.minAmount}.`}</Text>
              : null) : <Text style={styles.small}>{c.myRole === 'owner' || c.myRole === 'admin' ? 'Owner and admins are never gated.' : 'Members need to keep holding to post.'}</Text>}
            {gateError ? <Text style={[styles.small, styles.gateNo]}>{gateError}</Text> : null}
            {!c.myRole && socialReady() && gateState !== 'checking' ? <Pressable onPress={() => { void checkGate(true); }} hitSlop={8}><Text style={styles.readMore}>Check again</Text></Pressable> : null}
          </View> : null}
          {manager && onOpenManage ? <Pressable accessibilityRole="button" onPress={() => onOpenManage(c.id)} style={styles.manageButton}><Text style={styles.shareButtonText}>⚙ Manage {isChannel ? 'channel' : 'group'}</Text></Pressable> : null}
          {links?.eligible && hasProfileLinks(links.links) ? <ProfileLinkChips links={links.links} /> : null}
          <View style={styles.profileDescription}>
            <Text style={styles.cardTitle}>{isChannel ? 'Channel information' : 'About this group'}</Text>
            <Text numberOfLines={descriptionExpanded ? undefined : 3} style={styles.description}>{c.description || (isChannel ? 'A Kivo channel.' : 'A Kivo group.')}</Text>
            {(c.description?.length ?? 0) > 120 && <Pressable accessibilityRole="button" onPress={() => setDescriptionExpanded(value => !value)} hitSlop={8}><Text style={styles.readMore}>{descriptionExpanded ? 'Show less' : 'Read full description'}</Text></Pressable>}
            <View style={styles.profileStats}>
              <Text style={styles.stat}><Text style={styles.statValue}>{c.memberCount}</Text> {isChannel ? 'subscribers' : 'members'}</Text>
              <Text style={styles.stat}><Text style={styles.statValue}>{c.postCount}</Text> {isChannel ? 'posts' : 'messages'}</Text>
            </View>
          </View>
        </View>

        <CallStatsCard loadKey={c.id} load={() => api.communityCalls(c.id)} />
        {manager && <View style={styles.card}>
          <Text style={styles.cardTitle}>Links ★</Text>
          {links == null && !linksError ? <ActivityIndicator color={kivoTheme.colors.accent} /> : null}
          {linksError ? <Text style={styles.small}>{linksError}</Text> : null}
          {links ? <>
            <LinkFields value={linkDraft} onChange={setLinkDraft} editable={links.eligible && !busy} telegramPlaceholder={isChannel ? '@channel' : '@group'} />
            <Text style={styles.small}>{links.eligible
              ? `Shown on this ${isChannel ? 'channel' : 'group'}'s page while its owner's Blue Star is active.`
              : `Add a website, X and Telegram when the ${isChannel ? 'channel' : 'group'} owner has a Blue Star.`}</Text>
            {links.eligible
              ? <Pressable disabled={busy} onPress={saveLinks} style={[styles.secondary, busy && styles.disabled]}><Text style={styles.secondaryText}>Save links</Text></Pressable>
              : null}
          </> : null}
        </View>}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{isChannel && !manager ? 'Team' : 'Members'} · {members.length}</Text>
          {members.length === 0 ? <Text style={styles.muted}>{c.myRole ? 'No members to show.' : 'Join to see members.'}</Text> : members.map(member => {
            const target = member.userId;
            return (
              <View key={target} style={styles.memberRow}>
                <Pressable onPress={() => onOpenPerson?.(target)} style={styles.memberMain}>
                  <Avatar name={memberName(member)} uri={member.profile?.avatarUrl} size={38} verified={verifiedMembers.has(target)} />
                  <View style={styles.flex}><View style={styles.memberNameLine}><Text style={styles.memberName}>{memberName(member)}</Text>{verifiedMembers.has(target) ? <Text accessibilityLabel="Blue Star verified profile" style={styles.verifiedMemberBadge}>★</Text> : null}</View><Text style={styles.small}>{member.role === 'owner' ? 'Owner · protected' : member.role === 'admin' ? 'Admin' : 'Member'}{manager && member.restricted ? ' · muted' : ''}</Text></View>
                </Pressable>
              </View>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Permissions</Text>
          {manager && <Text style={styles.small}>Add, remove, mute, ban and promote people from Manage.</Text>}
          <Text style={styles.muted}>Owner: full control, cannot be removed or demoted. Only the owner promotes or demotes admins. {isChannel ? 'Owner and admins post; subscribers read.' : 'Admins add and remove regular members only.'} Admin is never ownership.</Text>
        </View>
        {c.myRole && c.myRole !== 'owner' && <Pressable onPress={run(() => api.leave(c.id), onBack)} style={styles.leave}><Text style={styles.danger}>{isChannel ? 'Unsubscribe' : 'Leave group'}</Text></Pressable>}
      </ScrollView>
    </View>
  );
}

function Header({ title, verified = false, onBack, onShare }: { title: string; verified?: boolean; onBack: () => void; onShare?: () => void }) {
  return <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><View style={styles.headerTitleLine}><Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>{verified ? <Text accessibilityLabel="Verified official Kivo channel" style={styles.verifiedBadge}>★</Text> : null}</View>{onShare ? <Pressable onPress={onShare}><Text style={styles.share}>Share</Text></Pressable> : <View />}</View>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  verifyCard: { padding: 11, borderRadius: 14, backgroundColor: kivoTheme.colors.surface, borderWidth: 1, borderColor: kivoTheme.colors.border, gap: 6 },
  verifyConfirm: { padding: 11, borderRadius: 12, backgroundColor: kivoTheme.colors.backgroundDeep, borderWidth: 1, borderColor: kivoTheme.colors.border, gap: 5 },
  verifyIntro: { color: kivoTheme.colors.textMuted, fontSize: 11.5, lineHeight: 16 },
  verifyConnect: { height: 38, borderRadius: 10, backgroundColor: kivoTheme.colors.surfaceRaised, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  verifyWalletReady: { color: kivoTheme.colors.accent, fontSize: 11.5, fontWeight: '700', marginTop: 2 },
  verifyPay: { minHeight: 40, borderRadius: 11, backgroundColor: kivoTheme.colors.cream, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  verifyPayText: { color: kivoTheme.colors.backgroundDeep, fontSize: 12.5, fontWeight: '900' },
  verifyProgress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 5 },
  verifyProgressText: { color: kivoTheme.colors.textMuted, fontSize: 11.5, flexShrink: 1 },
  verifyChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, marginBottom: 2 },
  verifyChoice: { borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 9 },
  verifyChoiceActive: { borderColor: kivoTheme.colors.accent, backgroundColor: kivoTheme.colors.surfaceRaised },
  verifyChoiceText: { color: kivoTheme.colors.text, fontSize: 13, fontWeight: '600' },
  receipt: { marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: kivoTheme.colors.surface },
  receiptText: { color: kivoTheme.colors.text, fontSize: 12, marginTop: 5 },

  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerTitleLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerTitle: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '800' },
  verifiedBadge: { overflow: 'hidden', color: '#2589F5', fontSize: 20, fontWeight: '900', textAlign: 'center', width: 20, height: 22 },
  share: { color: c.accent, fontWeight: '800' },
  body: { padding: 18, gap: 12, paddingBottom: 40 },
  profileHero: { padding: 12, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 12 },
  profileIdentity: { alignItems: 'center', gap: 6, paddingTop: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  title: { color: c.text, fontSize: 24, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
  profileSubtitle: { color: c.textMuted, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  profileActions: { flexDirection: 'row', gap: 10 },
  actionButton: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  primary: { marginTop: 6, alignSelf: 'stretch', height: 50, borderRadius: 25, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  shareButton: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  shareButtonText: { color: c.cream, fontWeight: '800' },
  manageButton: { minHeight: 44, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  profileDescription: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10, gap: 6 },
  profileStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  readMore: { color: c.accent, fontSize: 12, fontWeight: '800', paddingVertical: 2 },
  stat: { color: c.textMuted, fontSize: 12.5 },
  statValue: { color: c.text, fontWeight: '800' },
  description: { color: c.text, fontSize: 14, lineHeight: 20 },
  role: { color: c.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  muted: { color: c.textMuted, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  small: { color: c.textMuted, fontSize: 11.5 },
  primaryText: { color: c.backgroundDeep, fontWeight: '900' },
  card: { padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 8 },
  cardTitle: { color: c.text, fontWeight: '800', fontSize: 15 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: c.text, backgroundColor: c.backgroundDeep },
  secondary: { height: 42, borderRadius: 21, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: c.cream, fontWeight: '800' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  memberNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verifiedMemberBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 10, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 17, height: 17, borderRadius: 9, overflow: 'hidden' },
  memberName: { color: c.text, fontWeight: '700' },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: c.cream, fontSize: 11, fontWeight: '800' },
  danger: { color: c.danger, fontWeight: '800', fontSize: 12.5 },
  leave: { alignItems: 'center', padding: 14 },
  disabled: { opacity: 0.5 },
  gateBox: { padding: 10, borderRadius: 14, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: c.border, gap: 5 },
  gateTitle: { color: c.text, fontWeight: '800', fontSize: 13.5 },
  gateOk: { color: c.success },
  gateNo: { color: c.danger },
});
