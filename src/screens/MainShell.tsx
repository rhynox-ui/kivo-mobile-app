import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChatListScreen } from './ChatListScreen';
import type { TradeChain } from '@kivo/trading/core/chainData';
import { FeedScreen } from './FeedScreen';
import { ConversationScreen } from './ConversationScreen';
import { CommunitiesScreen } from './CommunitiesScreen';
import { CommunityScreen } from './CommunityScreen';
import { CommunitySettingsScreen } from './CommunitySettingsScreen';
import { PersonScreen } from './PersonScreen';
import { TradeScreen } from './TradeScreen';
import { WalletSummaryScreen } from './WalletSummaryScreen';
import { EditProfileScreen } from './EditProfileScreen';
import { SettingsScreen } from './SettingsScreen';
import { ProfileScreen } from './ProfileScreen';
import { VerificationScreen } from './VerificationScreen';
import { SecurityScreen } from './SecurityScreen';
import { DiscoverScreen } from './DiscoverScreen';
import { NotificationScreen } from './NotificationScreen';
import { ActivityScreen } from './ActivityScreen';
import { kivoTheme } from '../theme/kivoTheme';
import { useChatState } from '../state/useChat';
import { unreadCount } from '@kivo/shared/chat/store';
import type { CommunityKind } from '@kivo/shared/api/types';
import type { KivoToken, TradeSide } from '@kivo/trading/kivo/tokens';

type Tab = 'Chats' | 'Feed' | 'Discover' | 'Trade' | 'Profile';
type View_ =
  | { name: 'main' }
  | { name: 'conversation'; id: string }
  | { name: 'community'; id: string }
  | { name: 'communitySettings'; id: string }
  | { name: 'communities'; kind: CommunityKind }
  | { name: 'person'; userId: string }
  | { name: 'verification'; subjectType: 'profile' | 'channel'; subjectId: string; subjectName: string }
  | { name: 'wallet'; action?: 'deposit' | 'withdraw' } | { name: 'editProfile' } | { name: 'settings' } | { name: 'notifications' } | { name: 'activity' } | { name: 'security' };

const TAB_GLYPH: Record<Tab, string> = { Chats: '💬', Feed: '▤', Discover: '◎', Trade: '⇄', Profile: '◯' };

export function MainShell({ onLogout }: { onLogout?: () => void }) {
  const [tab, setTab] = useState<Tab>('Chats');
  const tabHistory = useRef<Tab[]>(['Chats']);
  const changeTab = useCallback((next: Tab) => {
    setTab(current => {
      if (current !== next) tabHistory.current = [...tabHistory.current, next];
      return next;
    });
  }, []);
  const [stack, setStack] = useState<View_[]>([{ name: 'main' }]);
  const [selectedToken, setSelectedToken] = useState<KivoToken | null>(null);
  const [discoverChain, setDiscoverChain] = useState<TradeChain | null>(null);
  const [shareDraft, setShareDraft] = useState<{ chain: string; address: string; text: string } | null>(null);
  const clearShareDraft = useCallback(() => setShareDraft(null), []);
  const [pendingFeedPostId, setPendingFeedPostId] = useState<string | null>(null);
  const [tradeSide, setTradeSide] = useState<TradeSide>('buy');
  const chat = useChatState();
  const unread = chat.conversations.reduce((sum, c) => sum + unreadCount(c.id), 0);

  const view = stack[stack.length - 1];
  const push = (next: View_) => setStack(s => [...s, next]);
  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = (next: Tab) => { setStack([{ name: 'main' }]); changeTab(next); };

  // Android system Back follows the in-app navigation history first. Nested
  // pages are popped before returning to the previously visited bottom tab.
  // At the app's root, return false so Android can use its normal exit behavior.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        back();
        return true;
      }
      if (tabHistory.current.length > 1) {
        const history = [...tabHistory.current];
        history.pop();
        const previous = history[history.length - 1];
        tabHistory.current = history;
        setTab(previous);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [stack.length, back]);
  const openChat = (id: string) => push({ name: 'conversation', id });
  const openCommunity = (id: string) => push({ name: 'community', id });
  // Tokens open straight in Trade (chart, price, MC, links, holders, contract); the separate token page was retired.
  const openToken = (token: KivoToken) => { setSelectedToken(token); setTradeSide('buy'); home('Trade'); };

  switch (view.name) {
    case 'verification': return <VerificationScreen subjectType={view.subjectType} subjectId={view.subjectId} subjectName={view.subjectName} onBack={back} />;
    case 'conversation': return <ConversationScreen id={view.id} onBack={back} onOpenInfo={id => openCommunity(id)} onOpenPerson={userId => push({ name: 'person', userId })} onOpenToken={token => openToken({ chainKey: token.chain as KivoToken['chainKey'], tokenAddress: token.address, symbol: token.symbol ?? '', name: token.name ?? '', imageUrl: token.imageUrl ?? null, priceUsd: null, change24h: null, marketCapUsd: null, liquidityUsd: null })} />;
    case 'community': return <CommunityScreen id={view.id} onBack={back} onOpenChat={openChat} onOpenPerson={userId => push({ name: 'person', userId })} onOpenVerification={(subjectType, subjectId, subjectName) => push({ name: 'verification', subjectType, subjectId, subjectName })} onOpenManage={id => push({ name: 'communitySettings', id })} />;
    case 'communitySettings': return <CommunitySettingsScreen id={view.id} onBack={back} onDeleted={() => home('Chats')} onOpenPerson={userId => push({ name: 'person', userId })} onOpenVerification={subjectId => push({ name: 'verification', subjectType: 'profile', subjectId, subjectName: 'your profile' })} />;
    case 'communities': return <CommunitiesScreen kind={view.kind} onBack={back} onOpenChat={openChat} onOpenInfo={openCommunity} onOpenVerification={subjectId => push({ name: 'verification', subjectType: 'profile', subjectId, subjectName: 'your profile' })} />;
    case 'person': return <PersonScreen userId={view.userId} onBack={back} onOpenChat={openChat} onOpenCommunity={openCommunity} />;
    case 'wallet': return <WalletSummaryScreen onBack={back} onTrade={() => home('Trade')} initialAction={view.action} />;
    case 'editProfile': return <EditProfileScreen onBack={back} onOpenVerification={(subjectId, subjectName) => push({ name: 'verification', subjectType: 'profile', subjectId, subjectName })} />;
    case 'notifications': return <NotificationScreen onBack={back} onOpenPost={postId => { back(); setPendingFeedPostId(postId); changeTab('Feed'); }} />;
    case 'activity': return <ActivityScreen onBack={back} />;
    case 'security': return <SecurityScreen onBack={back} />;
    case 'settings': return <SettingsScreen onBack={back} onOpenWallet={() => push({ name: 'wallet' })} onOpenProfile={() => push({ name: 'editProfile' })} onOpenSecurity={() => push({ name: 'security' })} onLogout={onLogout} />;
    default: break;
  }

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {tab === 'Feed' && <FeedScreen shareDraft={shareDraft} onShareDraftUsed={clearShareDraft} initialPostId={pendingFeedPostId} onPostOpened={() => setPendingFeedPostId(null)} onOpenToken={token => openToken({ chainKey: token.chain as KivoToken['chainKey'], tokenAddress: token.address, symbol: token.symbol, name: token.name, imageUrl: token.imageUrl, priceUsd: null, change24h: null, marketCapUsd: null, liquidityUsd: null })} />}
        {tab === 'Chats' && <ChatListScreen onOpenChat={openChat} onOpenCommunities={() => push({ name: 'communities', kind: 'group' })} onOpenNotifications={() => push({ name: 'notifications' })} />}
        {tab === 'Discover' && <DiscoverScreen initialChain={discoverChain} onSelectToken={openToken} onOpenChat={openChat} onOpenCommunity={openCommunity} onOpenPerson={userId => push({ name: 'person', userId })} />}
        {tab === 'Trade' && <TradeScreen selectedToken={selectedToken} initialSide={tradeSide} onToken={() => { setDiscoverChain(null); setTab('Discover'); }} onPickChain={chain => { setDiscoverChain(chain); setTab('Discover'); }} onShareToFeed={draft => { setShareDraft(draft); changeTab('Feed'); }} onOpenHistory={() => push({ name: 'activity' })} />}
        {tab === 'Profile' && <ProfileScreen
          onOpenWallet={(action?: 'deposit' | 'withdraw') => push({ name: 'wallet', action })}
          onOpenSettings={() => push({ name: 'settings' })}
          onOpenHistory={() => push({ name: 'activity' })}
          onOpenNotifications={() => push({ name: 'notifications' })}
          onEditProfile={() => push({ name: 'editProfile' })}
          onOpenChat={openChat}
          onOpenCommunities={() => push({ name: 'communities', kind: 'group' })}
          onOpenTrade={() => changeTab('Trade')}
          onOpenChats={() => changeTab('Chats')}
          onOpenVerification={(subjectId, subjectName) => push({ name: 'verification', subjectType: 'profile', subjectId, subjectName })}
          onOpenToken={openToken}
        />}
      </View>
      <View style={styles.nav}>
        {(['Chats', 'Feed', 'Discover', 'Trade', 'Profile'] as Tab[]).map(item => (
          <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} onPress={() => changeTab(item)} style={styles.navItem}>
            <View>
              <Text style={[styles.navGlyph, tab === item && styles.navActive]}>{TAB_GLYPH[item]}</Text>
              {item === 'Chats' && unread > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text></View>}
            </View>
            <Text style={[styles.navText, tab === item && styles.navActive]}>{item}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background },
  body: { flex: 1 },
  nav: { minHeight: 68, paddingBottom: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.backgroundDeep, flexDirection: 'row' },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navGlyph: { color: kivoTheme.colors.textMuted, fontSize: 18, textAlign: 'center' },
  navText: { color: kivoTheme.colors.textMuted, fontSize: 11, fontWeight: '600' },
  navActive: { color: kivoTheme.colors.accent, fontWeight: '800' },
  badge: { position: 'absolute', top: -4, right: -14, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: kivoTheme.colors.backgroundDeep, fontSize: 10, fontWeight: '900' },
});
