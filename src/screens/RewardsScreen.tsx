import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ReferralUser } from '@kivo/shared/api/client';
import { kivoAlert } from '../components/KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { api, enableSocial, useSocialReady } from '../state/session';
import { claimReferrer, getSuggestedReferrer, lookupReferrer, referralLink, refreshReferrals, shareReferralLink, shortReferralLink, subscribeReferralLinks, useReferrals } from '../state/referrals';
import { useProfile } from '../state/profileStore';

const c = kivoTheme.colors;
const REFRESH_MS = 30_000;

function usdParts(value: number | null | undefined): [string, string] {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const [whole, cents] = n.toFixed(2).split('.');
  return [`$${Number(whole).toLocaleString('en-US')}`, `.${cents}`];
}

function usd(value: number | null | undefined): string {
  const [whole, cents] = usdParts(value);
  return whole + cents;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Round for everyone, square-ish for Blue Star profiles (same as the feed: radius 10 at 40px). */
export function ReferralAvatar({ name, uri, size = 40, verified = false }: { name: string; uri?: string | null; size?: number; verified?: boolean }) {
  const borderRadius = verified ? Math.round(size / 4) : size / 2;
  return uri
    ? <Image source={{ uri, headers: api.mediaHeaders(uri) }} style={{ width: size, height: size, borderRadius, backgroundColor: c.surfaceRaised }} resizeMode="cover" />
    : <View style={[styles.avatarFallback, { width: size, height: size, borderRadius }]}><Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{(name || '?').replace(/^@/, '').slice(0, 1).toUpperCase()}</Text></View>;
}

function Star() {
  return <Text accessibilityLabel="Blue Star verified" style={styles.star}>★</Text>;
}

/** "Who referred you?": username → preview (avatar, name, Blue Star) → Confirm. */
function WhoReferredYou({ prefill }: { prefill: string | null }) {
  const [input, setInput] = useState(prefill ?? '');
  const [preview, setPreview] = useState<ReferralUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefillRef = useRef(prefill);

  const look = useCallback(async (value: string) => {
    const name = value.trim().replace(/^@/, '');
    if (!name) return;
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await lookupReferrer(name)); }
    catch (e) { setError(e instanceof Error && !/Request failed \(404\)/.test(e.message) ? e.message : `No Kivo user named @${name}.`); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    if (prefill && prefill !== prefillRef.current) { prefillRef.current = prefill; setInput(prefill); void look(prefill); }
    else if (prefill && !preview && input === prefill) void look(prefill);
    // Only when a new prefill arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const confirm = async () => {
    if (!preview) return;
    const unchanged = Boolean(prefillRef.current) && input.trim().replace(/^@/, '').toLowerCase() === prefillRef.current!.toLowerCase();
    setBusy(true); setError(null);
    try {
      const who = await claimReferrer(preview.username, unchanged ? 'install' : 'manual');
      kivoAlert('Referral saved', `@${who.username} referred you. You now follow them, and you pay 10% less in trading fees.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your referral. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Invited by a friend?</Text>
      <Text style={styles.muted}>Enter your friend’s referral code and enjoy 10% off trading fees for life. You can set this only once.</Text>
      <View style={styles.inputRow}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={input}
          onChangeText={text => { setInput(text); setPreview(null); setError(null); }}
          onSubmitEditing={() => { void look(input); }}
          placeholder="username"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          returnKeyType="search"
          style={styles.input}
        />
        {!preview ? <Pressable disabled={busy || !input.trim()} onPress={() => { void look(input); }} style={[styles.smallButton, (busy || !input.trim()) && styles.disabled]}><Text style={styles.smallButtonText}>Find</Text></Pressable> : null}
      </View>
      {busy && !preview ? <ActivityIndicator color={c.accent} style={{ marginTop: 10 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {preview ? (
        <View style={styles.preview}>
          <ReferralAvatar name={preview.username} uri={preview.avatarUrl} size={40} verified={preview.verified} />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}><Text style={styles.name}>{preview.username}</Text>{preview.verified ? <Star /> : null}</View>
            <Text style={styles.muted}>@{preview.username}</Text>
          </View>
          <Pressable disabled={busy} onPress={() => { void confirm(); }} style={[styles.confirm, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={c.backgroundDeep} /> : <Text style={styles.confirmText}>Confirm</Text>}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function RewardsScreen({ onBack, onOpenPerson, prefillReferrer }: { onBack: () => void; onOpenPerson: (userId: string) => void; prefillReferrer?: string | null }) {
  const me = useReferrals();
  const ready = useSocialReady();
  const profile = useProfile();
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(Boolean(me));
  const [prefill, setPrefill] = useState<string | null>(prefillReferrer ?? null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try { await refreshReferrals(); } finally { setLoaded(true); if (manual) setRefreshing(false); }
  }, []);

  useEffect(() => { if (ready) void load(); }, [ready, load]);
  // Live: refresh every 30s while this screen is open and the app is in front.
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refreshReferrals(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [ready]);
  useEffect(() => {
    let active = true;
    if (!prefillReferrer) void getSuggestedReferrer().then(code => { if (active && code) setPrefill(current => current ?? code); });
    const unsubscribe = subscribeReferralLinks(code => setPrefill(code));
    return () => { active = false; unsubscribe(); };
  }, [prefillReferrer]);
  useEffect(() => { if (prefillReferrer) setPrefill(prefillReferrer); }, [prefillReferrer]);

  const username = me?.username || profile.username;
  const link = referralLink(username, me);
  const [whole, cents] = usdParts(me?.totalEarnedUsd);
  const empty = me ? me.referralCount === 0 && me.recentRewards.length === 0 : false;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
        <Text style={styles.title}>Rewards</Text>
      </View>
      {!ready ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Sign in to Kivo with your wallet to see your rewards and invite friends.</Text>
          <Pressable style={[styles.share, { marginTop: 18 }]} onPress={() => { void enableSocial().catch(e => kivoAlert('Sign in', e instanceof Error ? e.message : 'Could not sign in.')); }}><Text style={styles.shareText}>Sign in</Text></Pressable>
        </View>
      ) : !me && !loaded ? (
        <View style={styles.center}><ActivityIndicator color={c.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void load(true); }} tintColor={c.accent} />} keyboardShouldPersistTaps="handled">
          {!me ? <Text style={styles.error}>Could not load your rewards. Pull down to try again.</Text> : null}
          <Text style={styles.label}>Total earned</Text>
          <Text style={styles.total}>{whole}<Text style={styles.cents}>{cents}</Text></Text>
          <Text style={styles.week}>+{usd(me?.thisWeekUsd)} this week</Text>

          <Pressable accessibilityRole="button" onPress={() => shareReferralLink(link)} style={styles.share}><Text style={styles.shareText}>⇪  Share</Text></Pressable>

          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>🎁 Refer and earn 25% of your friends' fees</Text>
            <Text style={styles.bannerBody}>Friends who join with your link get 10% off their fees. Rewards are paid weekly in USDC.</Text>
          </View>

          <View style={styles.linkRow}>
            <Text selectable numberOfLines={1} style={styles.link}>{shortReferralLink(link)}</Text>
            <Pressable accessibilityLabel="Share your link" hitSlop={10} onPress={() => shareReferralLink(link)}><Text style={styles.linkShare}>⇪</Text></Pressable>
          </View>
          {me ? <Text style={styles.clicks}>{me.clickCount ?? 0} {(me.clickCount ?? 0) === 1 ? 'click' : 'clicks'} → {me.referralCount} {me.referralCount === 1 ? 'sign-up' : 'sign-ups'}</Text> : null}

          <View style={styles.cards}>
            <View style={styles.statCard}>
              <View style={styles.nameRow}><Text style={styles.statLabel}>Referrals</Text><Text style={styles.badge}>25%</Text></View>
              <Text style={styles.statValue}>{usd(me?.totalEarnedUsd)}</Text>
              <Text style={styles.muted}>{me?.referralCount ?? 0} referred</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Paid out</Text>
              <Text style={styles.statValue}>{usd(me?.paidUsd)}</Text>
              <Text style={styles.muted}>{me && me.pendingUsd > 0 ? `${usd(me.pendingUsd)} pending` : 'Weekly in USDC'}</Text>
            </View>
          </View>

          {me?.canSetReferrer ? <WhoReferredYou prefill={prefill} /> : null}
          {me?.referredBy ? (
            <Pressable style={styles.referredBy} onPress={() => onOpenPerson(me.referredBy!.userId)}>
              <ReferralAvatar name={me.referredBy.username} uri={me.referredBy.avatarUrl} size={32} verified={me.referredBy.verified} />
              <Text style={[styles.muted, { flex: 1 }]}>Referred by <Text style={styles.name}>@{me.referredBy.username}</Text>{me.feeBps === 45 ? ' · you pay 0.45% fees' : ''}</Text>
              {me.referredBy.verified ? <Star /> : null}
            </Pressable>
          ) : null}

          {empty ? (
            <View style={styles.empty}><Text style={styles.emptyText}>Invite your friends to start earning 25% of their trading fees.</Text></View>
          ) : null}

          {me && me.referrals.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>People you referred</Text>
              {me.referrals.map(person => (
                <Pressable key={person.userId} style={styles.row} onPress={() => onOpenPerson(person.userId)}>
                  <ReferralAvatar name={person.username} uri={person.avatarUrl} size={40} verified={person.verified} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.nameRow}><Text style={styles.name} numberOfLines={1}>@{person.username}</Text>{person.verified ? <Star /> : null}</View>
                    <Text style={styles.muted}>Joined {ago(person.joinedAt)} · {usd(person.feesUsd)} fees</Text>
                  </View>
                  <Text style={styles.earned}>+{usd(person.earnedUsd)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {me && me.recentRewards.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent rewards</Text>
              {me.recentRewards.map(reward => (
                <View key={`${reward.chain}:${reward.txHash}`} style={styles.row}>
                  <ReferralAvatar name={reward.referredUsername} uri={reward.referredAvatarUrl} size={32} />
                  <Text style={[styles.rewardText, { flex: 1 }]} numberOfLines={1}><Text style={styles.earned}>+{usd(reward.rewardUsd)}</Text> from @{reward.referredUsername}</Text>
                  <Text style={styles.muted}>{ago(reward.createdAt)}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, marginBottom: 6 },
  back: { color: c.cream, fontSize: 38, width: 38, lineHeight: 42 },
  title: { color: c.text, fontSize: 34, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  label: { color: c.textMuted, fontSize: 14, fontWeight: '700', marginTop: 14 },
  total: { color: c.text, fontSize: 52, fontWeight: '900', marginTop: 4 },
  cents: { color: c.textMuted, fontSize: 52, fontWeight: '900', opacity: 0.55 },
  week: { color: c.success, fontSize: 15, fontWeight: '800', marginTop: 2 },
  share: { height: 52, borderRadius: 26, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center', marginTop: 20, paddingHorizontal: 28 },
  shareText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 16 },
  banner: { marginTop: 18, padding: 16, borderRadius: 20, backgroundColor: 'rgba(183,226,123,0.12)', borderWidth: 1, borderColor: 'rgba(183,226,123,0.35)', gap: 6 },
  bannerTitle: { color: c.text, fontSize: 16, fontWeight: '900' },
  bannerBody: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  linkRow: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, height: 50, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  link: { flex: 1, color: c.accent, fontSize: 14, fontWeight: '700' },
  linkShare: { color: c.cream, fontSize: 20 },
  clicks: { color: c.textMuted, fontSize: 12, marginTop: 8, marginLeft: 4 },
  cards: { flexDirection: 'row', gap: 10, marginTop: 16 },
  statCard: { flex: 1, padding: 14, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 4 },
  statLabel: { color: c.textMuted, fontSize: 13, fontWeight: '800' },
  statValue: { color: c.text, fontSize: 22, fontWeight: '900' },
  badge: { color: c.backgroundDeep, backgroundColor: c.accent, fontSize: 11, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, overflow: 'hidden' },
  card: { marginTop: 16, padding: 16, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 8 },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '900' },
  inputRow: { height: 52, borderRadius: 16, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: c.border, flexDirection: 'row', alignItems: 'center', paddingRight: 6, marginTop: 4 },
  at: { color: c.accent, fontSize: 17, fontWeight: '800', marginLeft: 14 },
  input: { flex: 1, color: c.text, fontSize: 16, paddingHorizontal: 8 },
  smallButton: { backgroundColor: c.cream, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 9 },
  smallButtonText: { color: c.backgroundDeep, fontWeight: '900' },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  confirm: { backgroundColor: c.accent, borderRadius: 18, paddingHorizontal: 18, height: 40, alignItems: 'center', justifyContent: 'center', minWidth: 96 },
  confirmText: { color: c.backgroundDeep, fontWeight: '900' },
  disabled: { opacity: 0.45 },
  error: { color: c.danger, fontSize: 13, marginTop: 6 },
  referredBy: { marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  empty: { marginTop: 22, padding: 20, borderRadius: 20, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, alignItems: 'center' },
  emptyText: { color: c.textMuted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  section: { marginTop: 24 },
  sectionTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: c.text, fontSize: 15, fontWeight: '800' },
  muted: { color: c.textMuted, fontSize: 12, lineHeight: 18 },
  earned: { color: c.success, fontSize: 14, fontWeight: '900' },
  rewardText: { color: c.text, fontSize: 14, fontWeight: '600' },
  star: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 11, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 17, height: 17, borderRadius: 9, overflow: 'hidden' },
  avatarFallback: { backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.cream, fontWeight: '900' },
});
