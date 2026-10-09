import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { LineChart } from '../components/LineChart';
import { kivoTheme } from '../theme/kivoTheme';
import { useProfile } from '../state/profileStore';
import { getWalletSession, subscribeToWallet, type WalletSession, localEvmSigner, withDeviceAccounts } from '../state/walletStore';
import { encodeFunctionData, parseUnits } from 'viem';
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { api, storage, useSocialReady } from '../state/session';
import { useChatState } from '../state/useChat';
import { updateSettings, useSettings } from '../state/settingsStore';
import type { ProfileSocial } from '@kivo/shared/api/types';
import { CHAIN_LABEL, tradeChainLabel } from '@kivo/trading/core/chainData';
import { subscribeToTradeHistory, type TradeRecord } from '@kivo/trading/kivo/history';
import { closedPositions, computePortfolioChange, fetchPortfolio, filterHistoryByRange, getPortfolioHistory, openHoldings, recordPortfolioSnapshot, type Portfolio, type PortfolioRange, type PortfolioSnapshot } from '@kivo/trading/kivo/portfolio';
import { formatAmount, formatUsd } from '@kivo/trading/kivo/tokens';
import { ConvertCashSheet } from '../components/ConvertCashSheet';

const RANGES: PortfolioRange[] = ['24h', '7d', '30d', 'All'];
type PositionTab = 'open' | 'closed';
type PositionFilter = 'all' | 'tokens' | 'cash';
const SMALL_BALANCE_THRESHOLD_USD = 0.5;
function shouldHideSmallHolding(holding: Portfolio['holdings'][number]): boolean {
  return holding.kind !== 'native' && holding.valueUsd != null && Number.isFinite(holding.valueUsd) && holding.valueUsd < SMALL_BALANCE_THRESHOLD_USD;
}

/** Mango Pro profile layout with Kivo graphics: identity + social row, portfolio chart, cash, positions, joined groups. */
export function ProfileScreen({ onOpenSettings, onOpenWallet, onOpenHistory, onOpenNotifications, onEditProfile, onOpenChat, onOpenCommunities, onOpenTrade, onOpenChats }: {
  onOpenSettings: () => void;
  onOpenWallet: (action?: 'deposit' | 'withdraw') => void;
  onOpenHistory?: () => void;
  onOpenNotifications?: () => void;
  onEditProfile?: () => void;
  onOpenChat?: (id: string) => void;
  onOpenCommunities?: () => void;
  onOpenTrade?: () => void;
  onOpenChats?: () => void;
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
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<PortfolioRange>('24h');
  const [positionTab, setPositionTab] = useState<PositionTab>('open');
  const [convertOpen, setConvertOpen] = useState(false);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [showVerification, setShowVerification] = useState(false);
  const [verificationPlan, setVerificationPlan] = useState<'monthly' | 'annual'>('annual');
  const [verificationChain, setVerificationChain] = useState<'ethereum' | 'base' | 'arbitrum' | 'solana'>('base');
  const [verificationStatus, setVerificationStatus] = useState<{isVerified: boolean; expiresAt: number | null; permanent: boolean} | null>(null);
  const [verificationReceipt, setVerificationReceipt] = useState<any>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationWalletReady, setVerificationWalletReady] = useState(false);
  const [verificationProgress, setVerificationProgress] = useState<'idle' | 'waiting' | 'checking'>('idle');
  useEffect(() => subscribeToWallet(setWallet), []);
  useEffect(() => subscribeToTradeHistory(setTrades), []);
  useEffect(() => { if (socialReady) api.social(profile.userId).then(setSocial).catch(() => {}); }, [socialReady, profile.userId]);
  const loadVerification = useCallback(() => {
    if (!socialReady) return;
    api.verificationStatus('profile', profile.userId).then(setVerificationStatus).catch(() => {});
  }, [socialReady, profile.userId]);
  useEffect(() => {
    loadVerification();
    const timer = setInterval(loadVerification, 60_000);
    return () => clearInterval(timer);
  }, [loadVerification]);

  const load = useCallback(async (forceFresh = false) => {
    if (!wallet) return;
    setLoading(true);
    try {
      const next = await fetchPortfolio(wallet.address, trades, {solanaAddress: wallet.solanaAddress, nearAddress: wallet.nearAddress}, {forceFresh});
      setPortfolio(next);
      setHistory(next.complete ? await recordPortfolioSnapshot(storage, wallet.address, next.totalUsd) : await getPortfolioHistory(storage, wallet.address));
    } catch {
      setHistory(await getPortfolioHistory(storage, wallet.address));
    } finally { setLoading(false); }
  }, [wallet, trades]);
  useEffect(() => { void load(); }, [load]);

  const groups = chat.conversations.filter(c => c.kind === 'group');
  const channels = chat.conversations.filter(c => c.kind === 'channel');
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
            {profile.avatarUri ? <Image source={{ uri: profile.avatarUri }} style={styles.avatar} /> : <View style={styles.avatar}><KivoMark size={70} /></View>}
            <View style={styles.editDot}><Text style={styles.editDotText}>✎</Text></View>
          </Pressable>
          <View style={styles.identityActions}>
            <Pressable onPress={onOpenNotifications} style={styles.iconButton} accessibilityLabel="Notifications"><Text style={styles.iconButtonText}>🔔</Text></Pressable>
            <Pressable onPress={() => Share.share({ message: `@${profile.username} on Kivo · https://kivo-web.pages.dev/u/${encodeURIComponent(profile.userId)}` }).catch(() => {})} style={styles.iconButton} accessibilityLabel="Share profile"><Text style={styles.iconButtonText}>⇪</Text></Pressable>
          </View>
        </View>
        <Text style={styles.username}>@{profile.username}</Text>
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
        {verificationStatus?.isVerified
          ? <Text style={styles.verificationActive}>★ Blue Star Verified · valid until {verificationStatus.expiresAt ? new Date(verificationStatus.expiresAt).toLocaleDateString() : 'permanent'}</Text>
          : <Pressable style={styles.verificationButton} onPress={() => setShowVerification(v => !v)}><Text style={styles.verificationButtonText}>★ Get Verified</Text></Pressable>}
        {showVerification && !verificationStatus?.isVerified && <View style={styles.verificationPanel}>
          <Text style={styles.verificationTitle}>Blue Star verification</Text>
          <Text style={styles.small}>Choose a plan and network, connect your Kivo wallet, then press Pay. Your badge activates only after Kivo verifies the on-chain payment.</Text>
          <View style={styles.verifyChoices}>{(['monthly', 'annual'] as const).map(p => <Pressable key={p} onPress={() => setVerificationPlan(p)} style={[styles.verifyChoice, verificationPlan === p && styles.verifyChoiceActive]}><Text style={styles.verifyChoiceText}>{p === 'monthly' ? '$1 USDC / month' : '$5 USDC / year'}</Text></Pressable>)}</View>
          <View style={styles.verifyChoices}>{(['ethereum', 'base', 'arbitrum', 'solana'] as const).map(n => <Pressable key={n} onPress={() => { setVerificationChain(n); setVerificationWalletReady(false); }} style={[styles.verifyChoice, verificationChain === n && styles.verifyChoiceActive]}><Text style={styles.verifyChoiceText}>{n === 'base' ? 'Base' : n === 'ethereum' ? 'Ethereum' : n === 'arbitrum' ? 'Arbitrum' : 'Solana'}</Text></Pressable>)}</View>
          {!verificationWalletReady
            ? <Pressable disabled={verificationBusy} style={styles.verifyConnect} onPress={() => {
                if (!socialReady) { Alert.alert('Kivo wallet', 'Sign in to Kivo before connecting your wallet.'); return; }
                const active = getWalletSession();
                if (!active) { Alert.alert('Kivo wallet', 'Create or unlock your Kivo wallet first.'); return; }
                setVerificationWalletReady(true);
                Alert.alert('Wallet ready', 'Your Kivo wallet is ready. Review the plan and network, then press Pay to approve the transaction.');
              }}><Text style={styles.verifyConnectText}>Connect Kivo wallet</Text></Pressable>
            : <Text style={styles.verifyWalletReady}>✓ Kivo wallet ready · {verificationChain[0].toUpperCase() + verificationChain.slice(1)}</Text>}
          {verificationWalletReady && <Pressable disabled={verificationBusy} style={styles.verificationButton} onPress={async () => {
            if (!socialReady) { Alert.alert('Kivo wallet', 'Sign in to Kivo before paying.'); return; }
            setVerificationBusy(true);
            setVerificationProgress('waiting');
            try {
              let txHash = '';
              if (verificationChain === 'solana') {
                txHash = await withDeviceAccounts('Approve Blue Star USDC payment', async ({solana}) => {
                  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
                  const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGZwyTDt1v');
                  const recipient = new PublicKey('2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki');
                  const sourceAta = await getAssociatedTokenAddress(mint, solana.publicKey);
                  if (!(await connection.getAccountInfo(sourceAta))) throw new Error('Your Kivo wallet has no Solana USDC token account. Fund it with USDC before paying.');
                  const destinationAta = await getAssociatedTokenAddress(mint, recipient);
                  const transaction = new Transaction();
                  if (!(await connection.getAccountInfo(destinationAta))) transaction.add(createAssociatedTokenAccountInstruction(solana.publicKey, destinationAta, recipient, mint));
                  transaction.add(createTransferCheckedInstruction(sourceAta, mint, destinationAta, solana.publicKey, verificationPlan === 'annual' ? 5_000_000n : 1_000_000n, 6));
                  return await sendAndConfirmTransaction(connection, transaction, [solana], {commitment: 'confirmed'});
                });
              } else {
                const chainIds = {ethereum: 1, base: 8453, arbitrum: 42161} as const;
                const usdc = {ethereum: '0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'} as const;
                const signer = await localEvmSigner();
                await signer.ensureChain(chainIds[verificationChain]);
                const data = encodeFunctionData({abi: [{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'value',type:'uint256'}],outputs:[{type:'bool'}]}],functionName:'transfer',args:['0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5',parseUnits(verificationPlan === 'annual' ? '5' : '1', 6)]});
                txHash = await signer.sendTransaction({to: usdc[verificationChain], data, value: 0n, chainId: chainIds[verificationChain]});
              }
              setVerificationProgress('checking');
              let receipt: any;
              for (let attempt = 0; ; attempt++) {
                try {
                  receipt = await api.purchaseVerification({subjectType: 'profile', subjectId: profile.userId, plan: verificationPlan, chain: verificationChain, txHash});
                  break;
                } catch (e) {
                  const message = e instanceof Error ? e.message : '';
                  if (attempt >= 7 || !/confirm|temporarily unavailable|retry|not finalized/i.test(message)) throw e;
                  await new Promise(resolve => setTimeout(resolve, Math.min(2500 + attempt * 1500, 9000)));
                }
              }
              setVerificationReceipt(receipt);
              await loadVerification();
              setShowVerification(false);
              Alert.alert('🎉 Congratulations!', 'Payment confirmed. Your Blue Star verification is now active, and your receipt is ready.');
            } catch (e) {
              setVerificationProgress('idle');
              Alert.alert('Payment not confirmed', e instanceof Error ? e.message : 'Could not verify payment. If a transaction was submitted, keep its hash and retry verification.');
            } finally { setVerificationBusy(false); }
          }}><Text style={styles.verificationButtonText}>{verificationBusy ? 'Paying securely…' : `Pay $${verificationPlan === 'annual' ? '5' : '1'} USDC & verify`}</Text></Pressable>}
          {verificationBusy && <View style={styles.verifyProgress}><ActivityIndicator size="small" color={kivoTheme.colors.accent} /><Text style={styles.small}>{verificationProgress === 'checking' ? 'Waiting for blockchain verification…' : 'Waiting for wallet approval and transaction confirmation…'}</Text></View>}
        </View>}
        {verificationReceipt && <View style={styles.verificationPanel}>
          <Text style={styles.verificationTitle}>★ Payment receipt — Paid & Verified</Text>
          <Text style={styles.small}>Profile: @{profile.username}</Text><Text style={styles.small}>Plan: {verificationReceipt.plan} · {verificationReceipt.amount} USDC</Text>
          <Text style={styles.small}>Network: {verificationReceipt.chain}</Text><Text style={styles.small}>Transaction: {verificationReceipt.txHash}</Text>
          <Text style={styles.small}>Payer: {verificationReceipt.payer || 'Not provided by verifier'}</Text><Text style={styles.small}>Recipient: {verificationReceipt.recipient}</Text>
          <Text style={styles.small}>Paid: {new Date(verificationReceipt.paidAt).toLocaleString()}</Text><Text style={styles.small}>Valid until: {new Date(verificationReceipt.expiresAt).toLocaleDateString()}</Text>
          <Pressable style={styles.verifyChoice} onPress={() => Share.share({message: `Kivo Verification Receipt\nStatus: Paid & Verified\nProfile: @${profile.username}\nPlan: ${verificationReceipt.plan}\nAmount: ${verificationReceipt.amount} USDC\nNetwork: ${verificationReceipt.chain}\nTransaction: ${verificationReceipt.txHash}\nPayer: ${verificationReceipt.payer || 'Not provided'}\nRecipient: ${verificationReceipt.recipient}\nPaid: ${new Date(verificationReceipt.paidAt).toISOString()}\nValid until: ${new Date(verificationReceipt.expiresAt).toISOString()}\nExplorer: ${verificationReceipt.explorerUrl}`})}><Text style={styles.verifyChoiceText}>Share receipt</Text></Pressable>
          <Pressable style={styles.verifyChoice} onPress={() => Share.share({message: verificationReceipt.txHash})}><Text style={styles.verifyChoiceText}>Share transaction hash</Text></Pressable>
          <Pressable style={styles.verifyChoice} onPress={() => { void import('react-native').then(({Linking}) => Linking.openURL(verificationReceipt.explorerUrl)); }}><Text style={styles.verifyChoiceText}>View transaction on explorer</Text></Pressable>
        </View>}
      </View>
      <View style={styles.divider} />

      <View style={styles.portfolioCard}>
        <View style={styles.portfolioTop}>
          <View>
            <Text style={styles.value}>{portfolio ? money(portfolio.totalUsd) : '…'}</Text>
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
        <View style={[styles.chart, !(points.length >= 2 && !hidden) && styles.chartEmptyBox]}>
          {!portfolio && loading ? <ActivityIndicator color={kivoTheme.colors.accent} />
            : hidden ? <Text style={styles.chartEmpty}>Balances hidden</Text>
            : points.length >= 2 ? <LineChart values={points.map(p => p.totalUsd)} />
            : <Text style={styles.chartEmpty}>No portfolio history yet — your chart builds as Kivo records your balance over time.</Text>}
        </View>
        {portfolio && !portfolio.complete && <Text style={styles.small}>Some networks did not respond — total may be incomplete.</Text>}
      </View>

      <View style={styles.cashCard}>
        <View style={styles.cashLeft}>
          <View style={styles.cashIcon}><Text style={styles.cashIconText}>$</Text></View>
          <View><Text style={styles.small}>Total cash</Text><Text style={styles.cashValue}>{portfolio ? money(portfolio.cashUsd) : '…'}</Text></View>
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
      {!portfolio ? <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 16 }} />
        : positionTab === 'open'
          ? (visibleOpen.length ? visibleOpen.map(h => (
            <View key={h.key} style={styles.position}>
              <View style={styles.tokenIcon}>{h.imageUrl ? <Image source={{ uri: h.imageUrl }} style={styles.tokenImage} /> : <Text style={styles.tokenLetter}>{h.symbol.slice(0, 1)}</Text>}</View>
              <View style={styles.flex}><Text style={styles.tokenName}>{h.symbol}</Text><Text style={styles.small}>{hidden ? '••••' : formatAmount(h.amount)} · {tradeChainLabel(h.chainKey)}</Text>{!hidden && h.entryPriceUsd != null && h.entryPriceUsd > 0 && h.priceUsd != null && h.priceUsd > 0 ? <Text style={[styles.small, h.priceUsd >= h.entryPriceUsd ? styles.up : styles.down]}>Entry {formatUsd(h.entryPriceUsd)} · {h.priceUsd >= h.entryPriceUsd ? '▲' : '▼'} {Math.abs((h.priceUsd / h.entryPriceUsd - 1) * 100).toFixed(2)}%</Text> : null}{!hidden && h.pnlUsd != null ? <Text style={[styles.small,h.pnlUsd>=0?styles.up:styles.down]}>PnL {h.pnlUsd>=0?'+':''}{formatUsd(h.pnlUsd)} {h.pnlPct!=null?`(${h.pnlPct>=0?'+':''}${h.pnlPct.toFixed(2)}%)`:''}</Text> : null}</View>
              <Text style={styles.positionValue}>{h.valueUsd == null ? 'No price' : money(h.valueUsd)}</Text>
            </View>
          )) : <Empty title="No positions yet" body="Your tokens and trading positions will appear here." />)
          : (closed.length ? closed.map(p => (
            <View key={p.key} style={styles.position}>
              <View style={styles.tokenIcon}><Text style={styles.tokenLetter}>{p.symbol.slice(0, 1)}</Text></View>
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

      <Text style={[styles.small, styles.padded]}>Native coins and cash on every supported chain, plus tokens you traded in Kivo.</Text>

      <View style={styles.positionsHead}>
        <Text style={styles.sectionTitle}>Joined groups</Text>
        {onOpenCommunities && <Pressable onPress={onOpenCommunities}><Text style={styles.seeAll}>See all</Text></Pressable>}
      </View>
      {[...groups, ...channels].length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {[...groups, ...channels].map(g => (
            <Pressable key={g.id} onPress={() => onOpenChat?.(g.id)} style={styles.groupCard}>
              <View style={styles.groupIcon}>{g.avatarUrl ? <Image source={{ uri: g.avatarUrl }} style={styles.tokenImage} /> : <Text style={styles.groupIconText}>{g.title.slice(0, 1).toUpperCase()}</Text>}</View>
              <Text style={styles.groupName} numberOfLines={1}>{g.title}</Text>
              <Text style={styles.small}>{g.kind === 'channel' ? 'Channel' : 'Group'} · {g.myRole === 'owner' ? 'Owner' : g.myRole === 'admin' ? 'Admin' : 'Member'}</Text>
            </Pressable>
          ))}
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
  username: { color: c.text, fontSize: 23, fontWeight: '800', marginTop: 4 },
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
  verificationPanel: { padding: 11, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 7 },
  verifyConnect: { minHeight: 38, borderRadius: 10, backgroundColor: c.backgroundDeep, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  verifyConnectText: { color: c.text, fontWeight: '800', fontSize: 12 },
  verifyWalletReady: { color: MINT, fontWeight: '800', fontSize: 11.5 },
  verifyProgress: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },

  verificationTitle: { color: c.text, fontWeight: '900', fontSize: 17 },
  verifyChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  verifyChoice: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.backgroundDeep },
  verifyChoiceActive: { borderColor: MINT, backgroundColor: c.surfaceRaised },
  verifyChoiceText: { color: c.text, fontWeight: '800', fontSize: 12 },
  verifyInput: { color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },

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
  groupName: { color: c.text, fontSize: 13, fontWeight: '800', marginTop: 8 },
});