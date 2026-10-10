import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { LineChart } from '../components/LineChart';
import { TokenIcon } from '../components/TokenIcon';
import { kivoTheme } from '../theme/kivoTheme';
import { useProfile } from '../state/profileStore';
import { getWalletSession, subscribeToWallet, type WalletSession } from '../state/walletStore';
import { api, storage, useSocialReady } from '../state/session';
import { useChatState } from '../state/useChat';
import { updateSettings, useSettings } from '../state/settingsStore';
import { hasProfileLinks, type ProfileLinks, type ProfileSocial } from '@kivo/shared/api/types';
import { ProfileLinkChips } from '../components/ProfileLinks';
import { CHAIN_LABEL, tradeChainLabel } from '@kivo/trading/core/chainData';
import { subscribeToTradeHistory, type TradeRecord } from '@kivo/trading/kivo/history';
import { chartTotal, closedPositions, computePortfolioChange, fetchPortfolio, filterHistoryByRange, getPortfolioHistory, missingSourceNames, openHoldings, recordPortfolioSnapshot, type ChartTotal, type Portfolio, type PortfolioRange, type PortfolioSnapshot } from '@kivo/trading/kivo/portfolio';
import { formatAmount, formatUsd } from '@kivo/trading/kivo/tokens';
import { ConvertCashSheet } from '../components/ConvertCashSheet';

const RANGES: PortfolioRange[] = ['24h', '7d', '30d', 'All'];
type PositionTab = 'open' | 'closed';
type PositionFilter = 'all' | 'tokens' | 'cash';
const SMALL_BALANCE_THRESHOLD_USD = 0.5;
/** Blue Star status is re-checked this often, and only while the app is in the foreground. */
const VERIFICATION_POLL_MS = 60_000;
function shouldHideSmallHolding(holding: Portfolio['holdings'][number]): boolean {
  return holding.kind !== 'native' && holding.valueUsd != null && Number.isFinite(holding.valueUsd) && holding.valueUsd < SMALL_BALANCE_THRESHOLD_USD;
}

/** Mango Pro profile layout with Kivo graphics: identity + social row, portfolio chart, cash, positions, joined groups. */
export function ProfileScreen({ onOpenSettings, onOpenWallet, onOpenHistory, onOpenNotifications, onEditProfile, onOpenChat, onOpenCommunities, onOpenTrade, onOpenChats, onOpenVerification }: {
  onOpenSettings: () => void;
  onOpenWallet: (action?: 'deposit' | 'withdraw') => void;
  onOpenHistory?: () => void;
  onOpenNotifications?: () => void;
  onEditProfile?: () => void;
  onOpenChat?: (id: string) => void;
  onOpenCommunities?: () => void;
  onOpenTrade?: () => void;
  onOpenChats?: () => void;
  onOpenVerification?: (subjectId: string, subjectName: string) => void;
}) {
  const profile = useProfile();
  const chat = useChatState();
  const socialReady = useSocialReady();
  const settings = useSettings();
  const hidden = settings.hideBalances;
  const [wallet, setWallet] = useState<WalletSession | null>(getWalletSession());
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [social, setSocial] = useState<ProfileSocial | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [history, setHistory] = useState<PortfolioSnapshot[]>([]);
  const [chart, setChart] = useState<ChartTotal | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [links, setLinks] = useState<ProfileLinks | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<PortfolioRange>('24h');
  const [positionTab, setPositionTab] = useState<PositionTab>('open');
  const [convertOpen, setConvertOpen] = useState(false);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [verificationStatus, setVerificationStatus] = useState<{isVerified: boolean; expiresAt: number | null; permanent: boolean} | null>(null);
  const [verifiedChannels, setVerifiedChannels] = useState<Set<string>>(() => new Set());
  useEffect(() => subscribeToWallet(setWallet), []);
  useEffect(() => subscribeToTradeHistory(setTrades), []);
  useEffect(() => { if (socialReady) api.social(profile.userId).then(setSocial).catch(() => {}); }, [socialReady, profile.userId]);
  // Verification status is public profile metadata; it must not depend on
  // enabling the separate social/chat session.
  const loadVerification = useCallback(() => {
    // A failed refresh keeps the last server answer instead of flickering the badge or the Get Verified button.
    api.verificationStatus('profile', profile.userId).then(setVerificationStatus).catch(() => {});
  }, [profile.userId]);
  useEffect(() => {
    // Never carry the previous account's verified presentation across an
    // account switch while the new server status is still loading.
    setVerificationStatus(null);
    loadVerification();
    // Keep the profile badge in sync after checkout activates a subscription,
    // without polling in the background. The Profile tab is unmounted when
    // another tab is shown, so this only runs while the screen is visible.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(loadVerification, VERIFICATION_POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') { loadVerification(); start(); } else stop();
    });
    return () => { stop(); subscription.remove(); };
  }, [loadVerification]);

  // The user's own Blue Star links (the server only returns them while the Blue Star is active).
  useEffect(() => {
    let active = true;
    setLinks(null);
    api.profileLinks(profile.userId).then(result => { if (active && result.verified && hasProfileLinks(result.links)) setLinks(result.links); }).catch(() => {});
    return () => { active = false; };
  }, [profile.userId, verificationStatus?.isVerified]);

  // Each portfolio request carries a sequence number and the wallet it was
  // made for; an answer for an older request or another wallet is dropped.
  const requestSeq = useRef(0);
  const walletAddress = wallet?.address ?? null;
  const walletRef = useRef<string | null>(walletAddress);
  walletRef.current = walletAddress;
  useEffect(() => {
    // Never show the previous wallet's balances, chart or error for a new wallet.
    requestSeq.current += 1;
    setPortfolio(null);
    setHistory([]);
    setChart(null);
    setPortfolioError(null);
    setLoading(false);
  }, [walletAddress]);

  const load = useCallback(async (forceFresh = false) => {
    if (!wallet) return;
    const seq = ++requestSeq.current;
    const owner = wallet.address;
    const current = () => seq === requestSeq.current && walletRef.current === owner;
    setLoading(true);
    try {
      const next = await fetchPortfolio(owner, trades, {solanaAddress: wallet.solanaAddress, nearAddress: wallet.nearAddress}, {forceFresh});
      if (!current()) return;
      // The chart only records a total when every source answered or has a
      // recent confirmed reading; otherwise no point is added.
      const nextChart = await chartTotal(storage, owner, next);
      const nextHistory = nextChart.totalUsd != null ? await recordPortfolioSnapshot(storage, owner, nextChart.totalUsd) : await getPortfolioHistory(storage, owner);
      if (!current()) return;
      setPortfolio(next);
      setChart(nextChart);
      setHistory(nextHistory);
      setPortfolioError(null);
    } catch {
      const saved = await getPortfolioHistory(storage, owner);
      if (!current()) return;
      setHistory(saved);
      setPortfolioError('Balances are unavailable right now. Pull down to try again.');
    } finally { if (seq === requestSeq.current) setLoading(false); }
  }, [wallet, trades]);
  useEffect(() => { void load(); }, [load]);

  const groups = chat.conversations.filter(c => c.kind === 'group');
  const channels = chat.conversations.filter(c => c.kind === 'channel');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      const ids = chat.conversations.filter(c => c.kind === 'channel').map(c => c.id);
      void Promise.all(ids.map(async id => {
        try { return (await api.verificationStatus('channel', id)).isVerified === true ? id : null; }
        catch { return null; }
      })).then(results => {
        if (active) setVerifiedChannels(new Set(results.filter((id): id is string => Boolean(id))));
      });
    };
    setVerifiedChannels(new Set());
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [chat.conversations]);
  const chats = chat.conversations.filter(c => c.kind === 'dm').length;
  const points = filterHistoryByRange(history, range);
  const change = computePortfolioChange(points);
  const open = portfolio ? openHoldings(portfolio).filter(h => filter === 'all' || (filter === 'tokens' ? h.kind !== 'cash' : h.kind === 'cash')) : [];
  const hiddenOpen = open.filter(shouldHideSmallHolding);
  const visibleOpen = settings.hideSmallBalances ? open.filter(h => !shouldHideSmallHolding(h)) : open;
  const closed = portfolio ? closedPositions(portfolio, trades) : [];
  const money = (value: number | null | undefined) => (hidden ? '••••' : formatUsd(value));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load(true); }} tintColor={kivoTheme.colors.accent} />}>
      <View style={styles.corner}>
        <Pressable onPress={onOpenHistory} hitSlop={10} accessibilityLabel="Trade history"><Text style={styles.cornerIcon}>◷</Text></Pressable>
        <Pressable onPress={onOpenSettings} hitSlop={10} accessibilityLabel="Settings"><Text style={styles.cornerIcon}>⚙</Text></Pressable>
      </View>

      <View style={styles.identity}>
        <View style={styles.avatarRow}>
          <Pressable onPress={onEditProfile} style={styles.avatarWrap} accessibilityLabel="Edit profile">
            {profile.avatarUri ? <Image source={{ uri: profile.avatarUri }} style={[styles.avatar, { borderRadius: verificationStatus?.isVerified === true ? 8 : 38 }]} /> : <View style={[styles.avatar, { borderRadius: verificationStatus?.isVerified === true ? 8 : 38 }]}><KivoMark size={70} /></View>}
            <View style={styles.editDot}><Text style={styles.editDotText}>✎</Text></View>
          </Pressable>
          <View style={styles.identityActions}>
            <Pressable onPress={onOpenNotifications} style={styles.iconButton} accessibilityLabel="Notifications"><Text style={styles.iconButtonText}>🔔</Text></Pressable>
            <Pressable onPress={() => Share.share({ message: `@${profile.username} on Kivo · https://kivo-web.pages.dev/u/${encodeURIComponent(profile.userId)}` }).catch(() => {})} style={styles.iconButton} accessibilityLabel="Share profile"><Text style={styles.iconButtonText}>⇪</Text></Pressable>
          </View>
        </View>
        <View style={styles.usernameRow}>
          <Text style={styles.username}>@{profile.username}</Text>
          {verificationStatus?.isVerified === true ? <Text accessibilityLabel="Blue Star verified" style={styles.blueStarBadge}>★</Text> : null}
        </View>
        {links ? <View style={styles.links}><ProfileLinkChips links={links} /></View> : null}
        {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : <Pressable onPress={onEditProfile}><Text style={styles.addBio}>+ Add a bio</Text></Pressable>}
        <View style={styles.follows}>
          <Text style={styles.followText}><Text style={styles.count}>{social?.following ?? 0}</Text> Following</Text>
          <Text style={styles.followText}><Text style={styles.count}>{social?.followers ?? 0}</Text> {social?.followers === 1 ? 'Follower' : 'Followers'}</Text>
        </View>
        {/* Social row: the user's groups, channels, chats and trades. */}
        <View style={styles.socialRow}>
          <Pressable onPress={onOpenCommunities}><Text style={styles.socialItem}>👥 {plural(groups.length, 'group', 'groups')}</Text></Pressable>
          <Pressable onPress={onOpenCommunities}><Text style={styles.socialItem}>📢 {plural(channels.length, 'channel', 'channels')}</Text></Pressable>
          <Pressable onPress={onOpenChats}><Text style={styles.socialItem}>💬 {plural(chats, 'chat', 'chats')}</Text></Pressable>
          <Pressable onPress={onOpenHistory}><Text style={styles.socialItem}>⇄ {plural(trades.length, 'trade', 'trades')}</Text></Pressable>
          <Text style={styles.socialItem}>▣ Joined {new Date(profile.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        </View>
      </View>
      <View style={styles.verificationEntry}>
        {verificationStatus?.isVerified === true
          ? <Text style={styles.verificationActive}>★ Blue Star Verified · valid until {verificationStatus.expiresAt ? new Date(verificationStatus.expiresAt).toLocaleDateString() : 'permanent'}</Text>
          // Only offer Get Verified once the server has confirmed this profile is NOT verified.
          : verificationStatus?.isVerified === false
            ? <Pressable style={styles.verificationButton} onPress={() => onOpenVerification?.(profile.userId, `@${profile.username}`)}><Text style={styles.verificationButtonText}>★ Get Verified</Text></Pressable>
            : null}
      </View>
      <View style={styles.divider} />

            <View style={styles.portfolioCard}>
        <View style={styles.portfolioTop}>
          <View>
            <Text style={styles.value}>{portfolio ? money(chart?.totalUsd ?? portfolio.totalUsd) : portfolioError ? '—' : '…'}</Text>
            <Pressable onPress={() => updateSettings({ hideBalances: !hidden })} style={styles.valueLabelRow}>
              {change && !hidden
                ? <Text style={[styles.change, change.isPositive ? styles.up : styles.down]}>{change.isPositive ? '▲ +' : '▼ −'}{formatUsd(Math.abs(change.absolute))} ({change.isPositive ? '+' : '−'}{Math.abs(change.percent).toFixed(2)}%)</Text>
                : <Text style={styles.valueLabel}>Portfolio value</Text>}
              <Text style={styles.eye}>{hidden ? '◌' : '◉'}</Text>
            </Pressable>
          </View>
          <View style={styles.ranges}>
            {RANGES.map(r => <Pressable key={r} onPress={() => setRange(r)} style={[styles.range, range === r && styles.rangeActive]}><Text style={[styles.rangeText, range === r && styles.rangeTextActive]}>{r}</Text></Pressable>)}
          </View>
        </View>
        <View style={[styles.chart, !(points.length >= 1 && !hidden) && styles.chartEmptyBox]}>
          {!portfolio && portfolioError ? <Text style={styles.chartEmpty}>{portfolioError}</Text>
            : !portfolio ? (wallet ? <ActivityIndicator color={kivoTheme.colors.accent} /> : <Text style={styles.chartEmpty}>Connect a wallet to see balances.</Text>)
            : hidden ? <Text style={styles.chartEmpty}>Balances hidden</Text>
            // One reading draws as a flat line: the value is known, it just hasn't moved yet.
            : points.length >= 2 ? <LineChart values={points.map(p => p.totalUsd)} />
            : points.length === 1 ? <LineChart values={[points[0].totalUsd, points[0].totalUsd]} />
            : null}
        </View>
      </View>

      <View style={styles.cashCard}>
        <View style={styles.cashLeft}>
          <View style={styles.cashIcon}><Text style={styles.cashIconText}>$</Text></View>
          <View><Text style={styles.small}>Total cash</Text><Text style={styles.cashValue}>{portfolio ? money(portfolio.cashUsd) : portfolioError ? '—' : '…'}</Text></View>
        </View>
        <View style={styles.cashActions}>
          <Square label="Deposit" glyph="↓" onPress={() => onOpenWallet('deposit')} />
          <Square label="Withdraw" glyph="↑" onPress={() => onOpenWallet('withdraw')} />
          <Square label="Convert" glyph="⇄" onPress={() => setConvertOpen(true)} />
        </View>
      </View>

      <View style={styles.positionsHead}>
        <Text style={styles.sectionTitle}>Positions</Text>
        <View style={styles.toggle}>
          {(['open', 'closed'] as PositionTab[]).map(t => <Pressable key={t} onPress={() => setPositionTab(t)} style={[styles.toggleItem, positionTab === t && styles.toggleActive]}><Text style={[styles.toggleText, positionTab === t && styles.toggleTextActive]}>{t === 'open' ? 'Open' : 'Closed'}</Text></Pressable>)}
        </View>
      </View>
      {positionTab === 'open' && <View style={styles.filters}>
        {(['all', 'tokens', 'cash'] as PositionFilter[]).map(f => <Pressable key={f} onPress={() => setFilter(f)} style={[styles.filter, filter === f && styles.filterActive]}><Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f === 'all' ? 'All' : f === 'tokens' ? 'Tokens' : 'Cash'}</Text></Pressable>)}
      </View>}
      {!portfolio ? (portfolioError || !wallet ? <Empty title="Balances unavailable" body={portfolioError ?? 'Connect a wallet to see balances.'} /> : <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 16 }} />)
        : positionTab === 'open'
          ? (visibleOpen.length ? visibleOpen.map(h => (
            <View key={h.key} style={styles.position}>
              <View style={styles.tokenIcon}><TokenIcon kind={h.kind} symbol={h.symbol} chainKey={h.chainKey as never} address={h.address} imageUrl={h.imageUrl} /></View>
              <View style={styles.flex}><Text style={styles.tokenName}>{h.symbol}</Text><Text style={styles.small}>{hidden ? '••••' : formatAmount(h.amount)} · {tradeChainLabel(h.chainKey)}</Text>{!hidden && h.entryPriceUsd != null && h.entryPriceUsd > 0 && h.priceUsd != null && h.priceUsd > 0 ? <Text style={[styles.small, h.priceUsd >= h.entryPriceUsd ? styles.up : styles.down]}>Entry {formatUsd(h.entryPriceUsd)} · {h.priceUsd >= h.entryPriceUsd ? '▲' : '▼'} {Math.abs((h.priceUsd / h.entryPriceUsd - 1) * 100).toFixed(2)}%</Text> : null}{!hidden && h.pnlUsd != null ? <Text style={[styles.small,h.pnlUsd>=0?styles.up:styles.down]}>PnL {h.pnlUsd>=0?'+':''}{formatUsd(h.pnlUsd)} {h.pnlPct!=null?`(${h.pnlPct>=0?'+':''}${h.pnlPct.toFixed(2)}%)`:''}</Text> : null}</View>
              <Text style={styles.positionValue}>{h.valueUsd == null ? 'No price' : money(h.valueUsd)}</Text>
            </View>
          )) : <Empty title="No positions yet" body="Your tokens and trading positions will appear here." />)
          : (closed.length ? closed.map(p => (
            <View key={p.key} style={styles.position}>
              <View style={styles.tokenIcon}><TokenIcon kind="token" symbol={p.symbol} chainKey={p.chainKey as never} address={p.address} imageUrl={p.imageUrl} /></View>
              <View style={styles.flex}><Text style={styles.tokenName}>{p.symbol}</Text><Text style={styles.small}>{tradeChainLabel(p.chainKey)} · closed</Text></View>
            </View>
          )) : <Empty title="No closed positions" body="Tokens you fully sell appear here." />)}
      <View style={styles.assetVisibilityRow}>
        <View style={styles.assetVisibilityCopy}>
          <Text style={styles.assetVisibilityTitle}>Hide zero or small balances</Text>
          <Text style={styles.assetVisibilityHint}>Hide balances under $0.50 from this list</Text>
        </View>
        <Pressable onPress={() => updateSettings({hideSmallBalances: !settings.hideSmallBalances})} style={[styles.visibilitySwitch, settings.hideSmallBalances && styles.visibilitySwitchOn]} accessibilityRole="switch" accessibilityState={{checked: settings.hideSmallBalances}}>
          <View style={[styles.visibilityThumb, settings.hideSmallBalances && styles.visibilityThumbOn]} />
        </Pressable>
      </View>
      {settings.hideSmallBalances && hiddenOpen.length > 0 ? <Pressable style={styles.showHiddenPill} onPress={() => updateSettings({hideSmallBalances: false})}><Text style={styles.showHiddenText}>Show hidden ({hiddenOpen.length})</Text></Pressable> : null}

      <Text style={[styles.small, styles.padded]}>Native coins and cash on every supported chain, tokens you traded in Kivo, and other tokens found by the wallet index.</Text>

      <View style={styles.positionsHead}>
        <Text style={styles.sectionTitle}>Joined groups</Text>
        {onOpenCommunities && <Pressable onPress={onOpenCommunities}><Text style={styles.seeAll}>See all</Text></Pressable>}
      </View>
      {[...groups, ...channels].length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {[...groups, ...channels].map(g => {
            const verified = g.kind === 'channel' ? verifiedChannels.has(g.id) : g.isVerified === true;
            return (
              <Pressable key={g.id} onPress={() => onOpenChat?.(g.id)} style={styles.groupCard}>
                <View style={[styles.groupIcon, { borderRadius: verified ? 8 : 21 }]}>{g.avatarUrl ? <Image source={{ uri: g.avatarUrl }} style={[styles.tokenImage, { borderRadius: verified ? 8 : 21 }]} /> : <Text style={styles.groupIconText}>{g.title.slice(0, 1).toUpperCase()}</Text>}</View>
                <View style={styles.groupNameLine}><Text style={styles.groupName} numberOfLines={1}>{g.title}</Text>{verified ? <Text accessibilityLabel="Verified community" style={styles.blueStarBadge}>★</Text> : null}</View>
                <Text style={styles.small}>{g.kind === 'channel' ? 'Channel' : 'Group'} · {g.myRole === 'owner' ? 'Owner' : g.myRole === 'admin' ? 'Admin' : 'Member'}</Text>
              </Pressable>
            );
          })}
      </ScrollView>
      ) : <Empty title="No groups yet" body={socialReady ? 'Join communities to make your profile social, not just financial.' : 'Turn on chats to join groups and channels.'} />}
      <ConvertCashSheet visible={convertOpen} onClose={() => setConvertOpen(false)} onConverted={() => { void load(true); }} />
    </ScrollView>
  );
}

function Square({ label, glyph, onPress }: { label: string; glyph: string; onPress?: () => void }) {
  return <Pressable onPress={onPress} style={styles.squareWrap}><View style={styles.square}><Text style={styles.squareText}>{glyph}</Text></View><Text style={styles.squareLabel}>{label}</Text></Pressable>;
}
function Empty({ title, body }: { title: string; body: string }) {
  return <View style={styles.empty}><View style={styles.emptyIcon}><Text style={styles.emptyGlyph}>▣</Text></View><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text></View>;
}

const c = kivoTheme.colors;
const MINT = '#C9F7A6';
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  content: { paddingBottom: 40 },
  flex: { flex: 1 },
  corner: { height: 40, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 22 },
  cornerIcon: { color: c.cream, fontSize: 21 },
  identity: { paddingHorizontal: 20, gap: 6 },
  avatarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  avatarWrap: { width: 76, height: 76 },
  avatar: { width: 76, height: 76, borderRadius: 22, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  editDot: { position: 'absolute', right: -5, bottom: -5, width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: c.background },
  editDotText: { color: c.backgroundDeep, fontSize: 12, fontWeight: '900' },
  identityActions: { flexDirection: 'row', gap: 10 },
  iconButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  iconButtonText: { color: c.text, fontSize: 17 },
  usernameRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 7 },
  username: { color: c.text, fontSize: 23, fontWeight: '800', marginTop: 4 },
  blueStarBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 13, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 22, height: 22, lineHeight: 22, borderRadius: 11, overflow: 'hidden', marginTop: 4 },
  links: { alignSelf: 'flex-start', marginTop: 2 },
  bio: { color: c.text, fontSize: 14.5, lineHeight: 20 },
  addBio: { color: c.textMuted, fontSize: 14, fontWeight: '700' },
  follows: { flexDirection: 'row', gap: 22 },
  followText: { color: c.textMuted, fontSize: 14 },
  count: { color: c.text, fontWeight: '800' },
  socialRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, marginTop: 2 },
  socialItem: { color: c.textMuted, fontSize: 13 },
  divider: { height: 1, backgroundColor: c.border, marginHorizontal: 20, marginTop: 12 },
  portfolioCard: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: 'rgba(159,232,112,0.22)' },
  portfolioTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  value: { color: c.text, fontSize: 30, fontWeight: '800' },
  valueLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  valueLabel: { color: c.accent, fontSize: 13.5 },
  change: { fontSize: 13, fontWeight: '800' },
  up: { color: '#2FD67B' },
  down: { color: '#FF6B6B' },
  eye: { color: c.accent, fontSize: 16 },
  ranges: { flexDirection: 'row', gap: 4 },
  range: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: c.backgroundDeep },
  rangeActive: { backgroundColor: MINT },
  rangeText: { color: c.textMuted, fontSize: 11.5, fontWeight: '800' },
  rangeTextActive: { color: '#10301F' },
  chart: { height: 130, marginTop: 10, alignItems: 'center', justifyContent: 'center' },
  chartEmptyBox: { height: 64 },
  chartEmpty: { color: c.textMuted, fontSize: 12.5, textAlign: 'center', paddingHorizontal: 20 },
  small: { color: c.textMuted, fontSize: 11.5 },
  verificationEntry: { marginHorizontal: 20, marginTop: 14, gap: 10 },
  verificationButton: { backgroundColor: MINT, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center' },
  verificationButtonText: { color: '#10301F', fontWeight: '900', fontSize: 14 },
  verificationActive: { color: MINT, fontWeight: '800', paddingVertical: 10 },
  verifyConfirm: { padding: 11, borderRadius: 12, backgroundColor: kivoTheme.colors.backgroundDeep, borderWidth: 1, borderColor: kivoTheme.colors.border, gap: 5 },
  verificationPanel: { width: '90%', maxWidth: 420, alignSelf: 'center', padding: 7, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 4 },
  verifyConnect: { minHeight: 38, borderRadius: 10, backgroundColor: c.backgroundDeep, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  verifyConnectText: { color: c.text, fontWeight: '800', fontSize: 12 },
  verifyWalletReady: { color: MINT, fontWeight: '800', fontSize: 11.5 },
  verifyProgress: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },

  verificationTitle: { color: c.text, fontWeight: '900', fontSize: 14 },
  verifyChoices: { flexDirection: 'row', flexWrap: 'nowrap', gap: 6 },
  verifyChoice: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: 5, paddingVertical: 5, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.backgroundDeep },
  verifyChoiceActive: { borderColor: MINT, backgroundColor: c.surfaceRaised },
  verifyChoiceText: { color: c.text, fontWeight: '800', fontSize: 12 },
  verifyInput: { color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },

  assetVisibilityRow: { marginHorizontal: 20, marginTop: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetVisibilityCopy: { flex: 1, paddingRight: 14 },
  assetVisibilityTitle: { color: c.text, fontSize: 13, fontWeight: '800' },
  assetVisibilityHint: { color: c.textMuted, fontSize: 10.5, marginTop: 2 },
  visibilitySwitch: { width: 46, height: 28, borderRadius: 14, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: c.border, padding: 2, justifyContent: 'center' },
  visibilitySwitchOn: { backgroundColor: MINT, borderColor: MINT },
  visibilityThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.textMuted },
  visibilityThumbOn: { alignSelf: 'flex-end', backgroundColor: '#10301F' },
  showHiddenPill: { alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginTop: 2 },
  showHiddenText: { color: c.accent, fontSize: 11.5, fontWeight: '800' },
  padded: { paddingHorizontal: 20, marginTop: 8 },
  cashCard: { margin: 18, marginBottom: 0, padding: 14, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cashLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cashIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  cashIconText: { color: c.cream, fontWeight: '800', fontSize: 18 },
  cashValue: { color: c.text, fontSize: 22, fontWeight: '800' },
  cashActions: { flexDirection: 'row', gap: 8 },
  squareWrap: { alignItems: 'center', gap: 4 },
  square: { width: 44, height: 44, borderRadius: 13, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  squareText: { color: c.text, fontSize: 18 },
  squareLabel: { color: c.textMuted, fontSize: 10.5 },
  positionsHead: { paddingHorizontal: 20, marginTop: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: c.text, fontSize: 22, fontWeight: '800' },
  seeAll: { color: c.accent, fontWeight: '800' },
  toggle: { flexDirection: 'row', backgroundColor: c.surface, borderRadius: 999, padding: 3, borderWidth: 1, borderColor: c.border },
  toggleItem: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999 },
  toggleActive: { backgroundColor: MINT },
  toggleText: { color: c.textMuted, fontWeight: '800', fontSize: 12.5 },
  toggleTextActive: { color: '#10301F' },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 12 },
  filter: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  filterActive: { backgroundColor: MINT, borderColor: MINT },
  filterText: { color: c.textMuted, fontWeight: '700' },
  filterTextActive: { color: '#10301F' },
  position: { marginHorizontal: 20, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  tokenIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tokenImage: { width: '100%', height: '100%' },
  tokenLetter: { color: c.cream, fontWeight: '800' },
  tokenName: { color: c.text, fontWeight: '800', fontSize: 15 },
  positionValue: { color: c.text, fontWeight: '800' },
  empty: { marginHorizontal: 18, marginTop: 12, padding: 22, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: 'center', gap: 6 },
  emptyIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: { color: c.accent, fontSize: 22 },
  emptyTitle: { color: c.text, fontWeight: '800', fontSize: 16 },
  emptyBody: { color: c.textMuted, fontSize: 12.5, textAlign: 'center' },
  strip: { gap: 10, paddingHorizontal: 20, paddingTop: 12 },
  groupCard: { width: 150, padding: 13, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  groupIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  groupIconText: { color: c.accent, fontWeight: '900', fontSize: 16 },
  groupNameLine: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 150 },
  groupName: { color: c.text, fontSize: 13, fontWeight: '800', marginTop: 8 },
});