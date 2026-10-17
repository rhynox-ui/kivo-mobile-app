import React, { useEffect, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { KivoModal } from './KivoModal';
import { KivoMark } from './KivoMark';
import { displayName, getChatState, sendText, subscribeChat } from '@kivo/shared/chat/store';
import type { ApiConversation } from '@kivo/shared/api/types';
import { tradeChainLabel, type TradeChain } from '@kivo/trading/core/chainData';

// One "Share" for a finished trade, like FOMO: a Kivo-branded card plus every
// place it can go — the Kivo feed, any chat/group/channel the user can post
// in, X, Telegram, or the phone's own share menu. Every external share links
// back to the token on kivotrade.site, so each share markets Kivo.

export type SharedTrade = {
  side: 'buy' | 'sell';
  chain: TradeChain;
  address: string;
  symbol: string;
  imageUrl: string | null;
  paid: string;
  received: string;
};

const SITE = 'https://kivotrade.site';

export function tradeShareLink(trade: Pick<SharedTrade, 'chain' | 'address'>): string {
  return `${SITE}/trade/${trade.chain}/${encodeURIComponent(trade.address)}?side=buy`;
}

export function tradeShareText(trade: SharedTrade): string {
  return `Just ${trade.side === 'buy' ? 'bought' : 'sold'} $${trade.symbol} on Kivo ⚡ ${trade.side === 'buy' ? `${trade.paid} → ${trade.received}` : `${trade.paid} → ${trade.received}`}`;
}

function canPost(conversation: ApiConversation): boolean {
  if (conversation.kind === 'dm') return true;
  const admin = conversation.myRole === 'owner' || conversation.myRole === 'admin';
  if (conversation.kind === 'channel') return admin;
  return !conversation.onlyAdminsPost || admin;
}

function titleOf(conversation: ApiConversation): string {
  if (conversation.kind !== 'dm') return conversation.title;
  return conversation.title || (conversation.peer?.username ? '@' + conversation.peer.username : displayName(conversation.peer?.userId));
}

export function ShareTradeSheet({ trade, visible, onClose, onShareToFeed }: {
  trade: SharedTrade | null;
  visible: boolean;
  onClose: () => void;
  onShareToFeed?: (draft: { chain: string; address: string; text: string }) => void;
}) {
  const [conversations, setConversations] = useState<ApiConversation[]>(() => getChatState().conversations);
  const [picking, setPicking] = useState(false);
  const [sent, setSent] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  useEffect(() => subscribeChat(state => setConversations(state.conversations)), []);
  useEffect(() => { if (!visible) { setPicking(false); setSent({}); } }, [visible]);
  if (!trade) return null;

  const link = tradeShareLink(trade);
  const text = tradeShareText(trade);
  const open = (url: string) => { Linking.openURL(url).catch(() => { void Share.share({ message: `${text}\n${link}` }).catch(() => {}); }); };
  const targets = conversations.filter(canPost).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const sendTo = async (conversation: ApiConversation) => {
    setSent(value => ({ ...value, [conversation.id]: 'sending' }));
    try {
      await sendText(conversation.id, text, undefined, { chain: trade.chain, address: trade.address });
      setSent(value => ({ ...value, [conversation.id]: 'sent' }));
    } catch {
      setSent(value => ({ ...value, [conversation.id]: 'failed' }));
    }
  };

  return (
    <KivoModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <KivoMark size={22} />
              <Text style={styles.brand}>kivo</Text>
              <Text style={styles.chain}>{tradeChainLabel(trade.chain)}</Text>
            </View>
            <View style={styles.cardBody}>
              {trade.imageUrl ? <Image source={{ uri: trade.imageUrl }} style={styles.tokenIcon} /> : <View style={styles.tokenIcon}><Text style={styles.tokenLetter}>{trade.symbol.slice(0, 1)}</Text></View>}
              <View style={styles.flex}>
                <Text style={styles.verb}>{trade.side === 'buy' ? 'Bought' : 'Sold'}</Text>
                <Text style={styles.symbol}>${trade.symbol}</Text>
              </View>
            </View>
            <View style={styles.amounts}>
              <View style={styles.flex}><Text style={styles.label}>{trade.side === 'buy' ? 'Paid' : 'Sold'}</Text><Text style={styles.value} numberOfLines={1}>{trade.paid}</Text></View>
              <View style={[styles.flex, styles.right]}><Text style={styles.label}>Received</Text><Text style={styles.value} numberOfLines={1}>{trade.received}</Text></View>
            </View>
            <Text style={styles.footer}>Trade any token, any chain · kivotrade.site</Text>
          </View>

          {picking ? (
            <>
              <View style={styles.pickHead}>
                <Pressable onPress={() => setPicking(false)} hitSlop={8}><Text style={styles.back}>‹ Back</Text></Pressable>
                <Text style={styles.title}>Send to a chat</Text>
              </View>
              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {targets.length ? targets.map(conversation => {
                  const status = sent[conversation.id];
                  return (
                    <Pressable key={conversation.id} disabled={status === 'sending' || status === 'sent'} onPress={() => void sendTo(conversation)} style={styles.row} accessibilityRole="button">
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{titleOf(conversation)}</Text>
                        <Text style={styles.rowSub}>{conversation.kind === 'dm' ? 'Chat' : conversation.kind === 'channel' ? 'Channel' : 'Group'}</Text>
                      </View>
                      <Text style={[styles.rowAction, status === 'failed' && styles.failed]}>{status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent ✓' : status === 'failed' ? 'Retry' : 'Send'}</Text>
                    </Pressable>
                  );
                }) : <Text style={styles.empty}>No chats yet. Join a group or start a chat first.</Text>}
              </ScrollView>
            </>
          ) : (
            <>
              <Text style={styles.title}>Share</Text>
              <View style={styles.grid}>
                {onShareToFeed ? <Option glyph="▤" label="Feed" onPress={() => { onClose(); onShareToFeed({ chain: trade.chain, address: trade.address, text }); }} /> : null}
                <Option glyph="💬" label="Chats" onPress={() => setPicking(true)} />
                <Option glyph="𝕏" label="X" onPress={() => open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`)} />
                <Option glyph="✈" label="Telegram" onPress={() => open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`)} />
                <Option glyph="⋯" label="More" onPress={() => { void Share.share({ message: `${text}\n${link}` }).catch(() => {}); }} />
              </View>
            </>
          )}
          <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>Close</Text></Pressable>
        </Pressable>
      </Pressable>
    </KivoModal>
  );
}

function Option({ glyph, label, onPress }: { glyph: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.option} accessibilityRole="button" accessibilityLabel={`Share to ${label}`}>
      <View style={styles.optionIcon}><Text style={styles.optionGlyph}>{glyph}</Text></View>
      <Text style={styles.optionLabel}>{label}</Text>
    </Pressable>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 28, borderWidth: 1, borderColor: c.border, maxHeight: '92%' },
  card: { borderRadius: 22, padding: 18, backgroundColor: c.backgroundDeep, borderWidth: 1, borderColor: 'rgba(183, 226, 123, 0.35)', marginBottom: 18 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brand: { color: c.cream, fontWeight: '900', fontSize: 18, flex: 1 },
  chain: { color: c.textMuted, fontWeight: '700', fontSize: 12 },
  cardBody: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  tokenIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  tokenLetter: { color: c.cream, fontWeight: '900', fontSize: 20 },
  verb: { color: c.accent, fontWeight: '800', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  symbol: { color: c.cream, fontWeight: '900', fontSize: 28 },
  amounts: { flexDirection: 'row', marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: c.border, gap: 12 },
  label: { color: c.textMuted, fontSize: 12, fontWeight: '700' },
  value: { color: c.text, fontSize: 16, fontWeight: '900', marginTop: 2 },
  right: { alignItems: 'flex-end' },
  footer: { color: c.textMuted, fontSize: 11, marginTop: 14, textAlign: 'center' },
  flex: { flex: 1 },
  title: { color: c.cream, fontSize: 18, fontWeight: '900', marginBottom: 12 },
  grid: { flexDirection: 'row', justifyContent: 'space-between' },
  option: { alignItems: 'center', width: 62 },
  optionIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  optionGlyph: { color: c.cream, fontSize: 20, fontWeight: '900' },
  optionLabel: { color: c.text, fontSize: 12, fontWeight: '700', marginTop: 6 },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4 },
  back: { color: c.accent, fontWeight: '800', fontSize: 14, marginBottom: 12 },
  list: { maxHeight: 280 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginBottom: 8 },
  rowTitle: { color: c.text, fontWeight: '800', fontSize: 14 },
  rowSub: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  rowAction: { color: c.accent, fontWeight: '900', fontSize: 13 },
  failed: { color: c.danger },
  empty: { color: c.textMuted, fontSize: 13, paddingVertical: 12 },
  close: { marginTop: 16, paddingVertical: 14, borderRadius: 999, backgroundColor: c.surfaceRaised, alignItems: 'center' },
  closeText: { color: c.cream, fontWeight: '900', fontSize: 15 },
});
