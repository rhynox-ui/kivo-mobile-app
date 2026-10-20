import React, { useEffect, useMemo, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { AppState, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { kivoAlert } from '../components/KivoAlert';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS, messageCharLimit, messageLength, shortWallet, type ApiMessage } from '@kivo/shared/api/types';
import { deleteForEveryone, discardMessage, displayName, editMessage, forwardMessage, getChatState, myUserId, retryMessage, sendImage, sendText, type LocalMessage } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { useActiveConversation, useChatState } from '../state/useChat';
import { Avatar } from './ChatListScreen';
import { api } from '../state/session';
import { useProfile } from '../state/profileStore';
import { KivoModal } from '../components/KivoModal';
import { BottomSheet } from '../components/BottomSheet';
import { PhotoViewer } from '../components/PhotoViewer';
import { TokenAttachmentCard } from '../components/TokenAttachmentCard';
import { TokenAttachmentPicker, type VerifiedToken } from '../components/TokenAttachmentPicker';
import { ChatPollCard } from '../components/ChatPollCard';
import { sendPoll } from '@kivo/shared/chat/store';
import { DEFAULT_POLL_SETTINGS, POLL_DURATION_OPTIONS, normalizePollQuestion, normalizePollDescription, normalizePollOptions, type PollSettings } from '@kivo/shared/polls/types';

type Item = { type: 'day'; key: string; label: string } | { type: 'unread'; key: string } | { type: 'message'; key: string; message: LocalMessage; showName: boolean; showAvatar: boolean };

// Server-defined reactions: one per person per message, members only.
const REACTIONS = ['👍', '❤️', '🔥', '🚀', '💎', '😂', '👀', '👎'];
type ReactionState = { counts: { emoji: string; count: number }[]; mine: string | null };
// Several pins per chat (newest first, up to 100); `pinned` is the newest.
// `mentions`: ids of messages mentioning the viewer that are still unread, oldest first.
type Extras = { pinned: LocalMessage | null; pins: LocalMessage[]; reactions: Record<string, ReactionState>; unreadMentions: number; mentions: string[] };
const EMPTY_EXTRAS: Extras = { pinned: null, pins: [], reactions: {}, unreadMentions: 0, mentions: [] };

type AttachmentSymbolKind = 'photo' | 'poll' | 'token';
function AttachmentSymbol({ kind, color }: { kind: AttachmentSymbolKind; color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {kind === 'photo' ? <>
        <Rect x={3} y={3} width={18} height={18} rx={2.5} />
        <Circle cx={15.5} cy={8.5} r={1.5} />
        <Path d="M4 17l5-5 3.5 3.5 2-2L20 19" />
      </> : kind === 'poll' ? <>
        <Path d="M4 20V13M10 20V9M16 20V5M22 20H2" />
        <Path d="M3 11l6-5 4 3 8-7" />
      </> : <>
        <Path d="M3 17l6-6 4 4 8-9" />
        <Path d="M15 6h6v6" />
      </>}
    </Svg>
  );
}
const asPins = (pins: ApiMessage[] | undefined, pinned: ApiMessage | null): LocalMessage[] => (pins ?? (pinned ? [pinned] : [])).map(m => ({ ...m, status: 'sent' as const }));
/** Telegram-style segmented bar: oldest at the top; shows at most 4 segments, windowed around the shown pin. */
function PinIndicator({ count, position }: { count: number; position: number }) {
  const visible = Math.min(count, 4);
  const first = Math.max(0, Math.min(position - 1, count - visible));
  return <View style={styles.pinIndicator}>{Array.from({ length: visible }, (_, i) => <View key={i} style={[styles.pinSegment, first + i === position && styles.pinSegmentActive]} />)}</View>;
}
/** Local guess shown until the server answers; the response replaces it. */
function applyReaction(current: ReactionState | undefined, next: string | null): ReactionState {
  const counts = (current?.counts ?? []).map(entry => ({ ...entry }));
  const bump = (emoji: string, delta: number) => { const row = counts.find(entry => entry.emoji === emoji); if (row) row.count += delta; else if (delta > 0) counts.push({ emoji, count: delta }); };
  if (current?.mine) bump(current.mine, -1); if (next) bump(next, 1);
  return { counts: counts.filter(entry => entry.count > 0), mine: next };
}
// @-mention picker: community members with a username (the server only resolves @username), cached per chat.
type MentionCandidate = { userId: string; username: string; avatarUrl: string | null };
const MENTION_TTL_MS = 5 * 60_000;
const mentionCache = new Map<string, { at: number; members: MentionCandidate[] }>();
/** The "@partial" right before the cursor (at the start or after a space), or null. */
function mentionAt(text: string, cursor: number): { query: string; start: number } | null {
  const match = /(^|\s)@([A-Za-z0-9_]*)$/.exec(text.slice(0, cursor));
  return match ? { query: match[2], start: cursor - match[2].length - 1 } : null;
}
// Tapped @username → userId (null = no such Kivo user), cached for the session.
const usernameCache = new Map<string, Promise<string | null>>();
function resolveUsername(username: string): Promise<string | null> {
  const key = username.toLowerCase(); const cached = usernameCache.get(key); if (cached) return cached;
  const lookup = api.searchProfiles(username).then(found => found.find(p => p.username?.toLowerCase() === key)?.userId ?? null);
  usernameCache.set(key, lookup); lookup.catch(() => usernameCache.delete(key)); // network errors are retried on the next tap
  return lookup;
}
function pinnedPreview(message: LocalMessage): string {
  return message.deleted ? 'Message deleted' : message.text ? message.text.replace(/\s+/g, ' ') : message.token ? '🪙 ' + (message.token.symbol ?? message.token.name ?? 'Token') : message.media ? '📷 Photo' : 'Message';
}

function renderLinkedText(text: string, myUsername?: string | null, onMention?: (username: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match Web's full EVM addresses and Solana public keys, as well as existing links and tags.
  const pattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?<![1-9A-HJ-NP-Za-km-z])(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])|#[\p{L}\p{N}_]+|\$[A-Za-z][A-Za-z0-9_]*|@[A-Za-z0-9_]+/gu;
  let cursor = 0; let key = 0; const mine = myUsername?.replace(/^@/, '').toLowerCase();
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]; const start = match.index ?? 0;
    if (raw.startsWith('@') && start > 0 && /[\w.]/.test(text[start - 1])) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    if (/^0x[a-fA-F0-9]{40}$/.test(raw) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
      nodes.push(<React.Fragment key={'address-' + key++}>
        <Text selectable>{raw}</Text>
        <Text accessibilityRole="button" accessibilityLabel="Copy address" onPress={() => {
          Clipboard.setString(raw);
          kivoAlert('Address copied', 'Address copied to clipboard.');
        }} style={styles.messageLink}> ⧉</Text>
      </React.Fragment>);
      cursor = start + raw.length;
      continue;
    }
    if (raw.startsWith('@')) {
      nodes.push(<Text key={'mention-' + key++} accessibilityRole={onMention ? 'link' : undefined} onPress={onMention ? () => onMention(raw.slice(1)) : undefined} style={mine && raw.slice(1).toLowerCase() === mine ? styles.messageMentionMe : styles.messageMention}>{raw}</Text>);
      cursor = start + raw.length;
      continue;
    }
    let url: string; let style: TextStyle = styles.messageLink;
    if (raw.startsWith('#')) { url = 'https://x.com/hashtag/' + encodeURIComponent(raw.slice(1)); style = styles.messageHashtag; }
    else if (raw.startsWith('$')) { url = 'https://dexscreener.com/search?q=' + encodeURIComponent(raw.slice(1)); style = styles.messageTicker; }
    else {
      const clean = raw.replace(/[),.!?;:]+$/, ''); url = clean.startsWith('www.') ? 'https://' + clean : clean;
      nodes.push(<Text key={'link-' + key++} accessibilityRole="link" onPress={() => Linking.openURL(url).catch(() => kivoAlert('Link', 'Could not open this link.'))} style={style}>{clean}</Text>);
      const tail = raw.slice(clean.length); if (tail) nodes.push(tail); cursor = start + raw.length; continue;
    }
    nodes.push(<Text key={'link-' + key++} accessibilityRole="link" onPress={() => Linking.openURL(url).catch(() => kivoAlert('Link', 'Could not open this link.'))} style={style}>{raw}</Text>);
    cursor = start + raw.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length ? nodes : [text];
}

/**
 * Photos are compressed by the picker itself (downscaled to 1280px and
 * re-encoded as JPEG) before upload, so a typical chat photo is tens of KB.
 */
async function pickCompressedPhoto(): Promise<{ bytes: Blob; type: string; width: number; height: number; previewUrl: string } | null> {
  const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, maxWidth: API_LIMITS.imageMaxEdge, maxHeight: API_LIMITS.imageMaxEdge, quality: 0.6, includeBase64: false });
  if (result.didCancel) return null;
  if (result.errorCode) throw new Error(result.errorMessage ?? 'Could not open your photos.');
  const asset = result.assets?.[0];
  if (!asset?.uri) return null;
  if (asset.fileSize && asset.fileSize > API_LIMITS.maxImageBytes) throw new Error(`That photo is still ${Math.round(asset.fileSize / 1024)} KB after compression (limit ${Math.round(API_LIMITS.maxImageBytes / 1024)} KB). Try another photo.`);
  const bytes = await (await fetch(asset.uri)).blob();
  if (bytes.size > API_LIMITS.maxImageBytes) throw new Error('That photo is too large even after compression. Try another photo.');
  return { bytes, type: asset.type === 'image/png' ? 'image/png' : 'image/jpeg', width: asset.width ?? 0, height: asset.height ?? 0, previewUrl: asset.uri };
}

function MessagePhoto({ uri, width, height, onOpen, onLongPress }: { uri: string; width: number | null; height: number | null; onOpen?: () => void; onLongPress?: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  const dimensions = width && height ? { aspectRatio: width / height } : null;
  if (failed) {
    return (
      <View style={[styles.photo, dimensions, styles.photoUnavailable]} accessibilityLabel="Message photo unavailable">
        <Text style={styles.photoUnavailableText}>Photo unavailable</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={onOpen} onLongPress={onLongPress} disabled={!onOpen} accessibilityRole="imagebutton" accessibilityLabel="Open photo">
      <Image
        source={{ uri: uri.split('?')[0], headers: api.mediaHeaders(uri.split('?')[0]) }}
        style={[styles.photo, dimensions]}
        resizeMode="cover"
        onError={() => setFailed(true)}
        accessibilityLabel="Message photo"
      />
    </Pressable>
  );
}

export function ConversationScreen({ id, onBack, onOpenInfo, onOpenPerson, onOpenToken }: { id: string; onBack?: () => void; onOpenInfo?: (id: string, kind: 'group' | 'channel') => void; onOpenPerson?: (userId: string) => void; onOpenToken?: (token: NonNullable<LocalMessage['token']>) => void }) {
  useActiveConversation(id);
  const state = useChatState();
  const conversation = state.conversations.find(c => c.id === id);
  const messages = state.messages[id] ?? [];
  // Read position from before this open (useActiveConversation marks the chat read
  // after the first render), so the chat can open at the first unread message.
  const initialRead = useMemo(() => getChatState().lastRead[id] ?? 0, [id]);
  const findFirstUnread = (list: LocalMessage[]) => { const self = myUserId(); return list.find(m => m.seq > initialRead && m.senderId !== self && !m.deleted) ?? null; };
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(() => findFirstUnread(messages)?.id ?? null);
  const unreadDecided = useRef(messages.length > 0);
  const pendingJump = useRef(firstUnreadId !== null);
  const jumpRetries = useRef(0);
  const [extras, setExtras] = useState<Extras | null>(null);
  const [reactingTo, setReactingTo] = useState<LocalMessage | null>(null);
  const profile = useProfile();
  const [draft, setDraft] = useState('');
  const [pollComposerOpen,setPollComposerOpen]=useState(false),[pollQuestion,setPollQuestion]=useState(''),[pollDescription,setPollDescription]=useState(''),[pollOptions,setPollOptions]=useState(['','']),[pollSettings,setPollSettings]=useState<PollSettings>({...DEFAULT_POLL_SETTINGS}),[pollDuration,setPollDuration]=useState<number|null>(null),[pollSending,setPollSending]=useState(false);
  const [tokenAttachmentOpen, setTokenAttachmentOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  // Set by the picker once the pasted token has a live market (null while checking or empty).
  const [verifiedTokenAttachment, setVerifiedTokenAttachment] = useState<VerifiedToken|null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  type MenuItem = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };
  const [optionsMenu, setOptionsMenu] = useState<MenuItem[] | null>(null);
  const [optionsMessage, setOptionsMessage] = useState<LocalMessage | null>(null);
  const [selectedTextMessageId, setSelectedTextMessageId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<LocalMessage | null>(null);
  const [viewing, setViewing] = useState<LocalMessage | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<LocalMessage | null>(null);
  const list = useRef<FlatList<Item>>(null);
  const atBottom = useRef(firstUnreadId === null);
  const previousMessageCount = useRef(messages.length);
  const [unseenMessages, setUnseenMessages] = useState(() => { const self = myUserId(); return firstUnreadId ? messages.filter(m => m.seq > initialRead && m.senderId !== self && !m.deleted).length : 0; });
  const me = myUserId();
  const myUsername = (me ? state.profiles[me]?.username : null) ?? profile.username ?? null;
  // Messages may arrive after opening (empty cache): decide the unread jump once, on the first load.
  useEffect(() => {
    if (unreadDecided.current || !messages.length) return;
    unreadDecided.current = true;
    const first = findFirstUnread(messages);
    if (!first) return;
    setFirstUnreadId(first.id); pendingJump.current = true; atBottom.current = false;
    setUnseenMessages(messages.filter(m => m.seq > initialRead && m.senderId !== me && !m.deleted).length);
  }, [messages]);
  // Unread @mentions are marked read one by one (seen on screen or via the "@" button), batched.
  const seenMentions = useRef<Set<string>>(new Set());
  const mentionBatch = useRef<string[]>([]);
  const mentionFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushMentions = () => {
    mentionFlush.current = null;
    const ids = mentionBatch.current; mentionBatch.current = [];
    if (ids.length) void api.markMentionsRead(id, ids).catch(() => { ids.forEach(m => seenMentions.current.delete(m)); });
  };
  const markMentionsSeen = (ids: string[]) => {
    const fresh = ids.filter(m => !seenMentions.current.has(m)); if (!fresh.length) return;
    fresh.forEach(m => seenMentions.current.add(m)); mentionBatch.current.push(...fresh);
    setExtras(prev => prev && { ...prev, mentions: prev.mentions.filter(m => !fresh.includes(m)) });
    if (!mentionFlush.current) mentionFlush.current = setTimeout(flushMentions, 500);
  };
  useEffect(() => () => { if (mentionFlush.current) { clearTimeout(mentionFlush.current); flushMentions(); } }, [id]);
  const unreadMentionIds = extras?.mentions ?? [];
  const unreadMentionSet = useMemo(() => new Set(unreadMentionIds), [unreadMentionIds]);
  // FlatList wants a stable viewability callback: it reads the latest state through a ref.
  const viewabilityHandler = useRef<(keys: string[]) => void>(() => {});
  viewabilityHandler.current = keys => { const seen = keys.filter(k => unreadMentionSet.has(k)); if (seen.length) markMentionsSeen(seen); };
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60, minimumViewTime: 1000 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { key: string; isViewable: boolean }[] }) => viewabilityHandler.current(viewableItems.filter(v => v.isViewable).map(v => v.key))).current;
  // @username taps open that Kivo profile.
  const openMention = (username: string) => {
    resolveUsername(username).then(userId => { if (userId) onOpenPerson?.(userId); else kivoAlert('Mention', `No Kivo user @${username}`); })
      .catch(error => kivoAlert('Mention', error instanceof Error ? error.message : 'Could not open this profile.'));
  };
  // Pinned message, reactions and unread @mentions: polled while the chat is open and the app is in front.
  useEffect(() => {
    let active = true;
    setExtras(null);
    const load = () => {
      if (AppState.currentState !== 'active') return;
      api.conversationExtras(id).then(next => {
        if (!active) return;
        // Mentions seen here but not yet confirmed by the server stay hidden.
        setExtras({ pinned: next.pinned ? { ...next.pinned, status: 'sent' } : null, pins: asPins(next.pins, next.pinned), reactions: next.reactions, unreadMentions: next.unreadMentions, mentions: (next.mentions ?? []).filter(m => !seenMentions.current.has(m)) });
      }).catch(() => {});
    };
    seenMentions.current = new Set(); mentionBatch.current = [];
    load();
    const timer = setInterval(load, 15_000);
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') load(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [id]);
  // Message length comes from the server's live Blue Star rules (GET /api/limits).
  // The server enforces this; the counter only helps before sending.
  const [verifiedSender, setVerifiedSender] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!me) return;
    let active = true;
    api.verificationStatus('profile', me).then(status => { if (active) setVerifiedSender(status.isVerified === true); }).catch(() => {});
    return () => { active = false; };
  }, [me]);
  const editingOriginal = editingMessageId ? messages.find(m => m.id === editingMessageId)?.text ?? '' : '';
  // An edit may keep an old message as long as it already was.
  const charLimit = Math.max(messageCharLimit(verifiedSender), editingMessageId ? messageLength(editingOriginal) : 0);
  const draftLength = messageLength(draft.trim());
  const overLimit = draftLength > charLimit;
  // Show the counter as the draft nears the limit, for Blue Star accounts too.
  const showCounter = draftLength >= charLimit - (verifiedSender ? 500 : 100);
  const [peerVerified, setPeerVerified] = useState(false);
  const [verifiedSenders, setVerifiedSenders] = useState<Set<string>>(() => new Set());
  const senderIds = useMemo(() => Array.from(new Set(messages.filter(message => message.senderId !== me).map(message => message.senderId))), [messages, me]);
  const senderKey = senderIds.join('|');
  useEffect(() => {
    let active = true;
    // Do not keep the previous sender set visible while the current
    // conversation's authoritative verification checks are pending.
    setVerifiedSenders(new Set());
    const refresh = () => {
      const ids = senderKey ? senderKey.split('|') : [];
      void Promise.all(ids.map(async userId => {
        try { return (await api.verificationStatus('profile', userId)).isVerified === true ? userId : null; }
        catch { return null; }
      })).then(results => {
        if (active) setVerifiedSenders(new Set(results.filter((userId): userId is string => Boolean(userId))));
      });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [senderKey]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (conversation?.kind !== 'dm' || !conversation.peer?.userId) {
        setPeerVerified(false);
        return;
      }
      void api.verificationStatus('profile', conversation.peer.userId)
        .then(status => { if (active) setPeerVerified(status.isVerified === true); })
        .catch(() => { if (active) setPeerVerified(false); });
    };
    setPeerVerified(false);
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [conversation?.kind, conversation?.peer?.userId]);
  const isChannel = conversation?.kind === 'channel';
  const canModerate = conversation?.myRole === 'owner' || conversation?.myRole === 'admin';
  // Channels: only the owner and admins post. Groups can be set to admins-only too.
  // The server enforces both; this only avoids offering a composer that would fail.
  const adminsOnly = isChannel || (conversation?.kind === 'group' && conversation.onlyAdminsPost === true);
  const canPost = !conversation || !adminsOnly || canModerate;
  // Server rules: members react; only owner/admins pin, in groups and channels (no pinning in DMs).
  const canReact = conversation?.kind === 'dm' || Boolean(conversation?.myRole);
  const canPin = conversation?.kind !== 'dm' && canModerate;
  const pins = extras?.pins ?? [];
  // Which pin the bar shows (0 = newest); tapping the bar jumps to it, then moves to the next older one.
  const [pinIndex, setPinIndex] = useState(0);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => { if (!highlightedId) return; const timer = setTimeout(() => setHighlightedId(null), 1600); return () => clearTimeout(timer); }, [highlightedId]);
  const shownPinIndex = pins.length ? Math.min(pinIndex, pins.length - 1) : 0;
  const pinned = pins[shownPinIndex] ?? null;
  useEffect(() => { if (!pins.length) setPinsOpen(false); }, [pins.length]);
  const listExtra = useMemo(() => ({ extras, highlightedId }), [extras, highlightedId]);
  // @-mentions: groups, channels (admins post there) and DMs (the other person).
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | null>(null);
  const [mentionPool, setMentionPool] = useState<MentionCandidate[] | null>(() => mentionCache.get(id)?.members ?? null);
  const mentionsAllowed = conversation?.kind === 'dm' || conversation?.kind === 'group' || (conversation?.kind === 'channel' && canModerate);
  const mention = mentionsAllowed && selection.start === selection.end ? mentionAt(draft, selection.start) : null;
  const mentionActive = mention !== null;
  useEffect(() => { setMentionPool(mentionCache.get(id)?.members ?? null); }, [id]);
  useEffect(() => {
    if (!mentionActive || !conversation) return;
    if (conversation.kind === 'dm') { const peer = conversation.peer; setMentionPool(peer?.username ? [{ userId: peer.userId, username: peer.username, avatarUrl: peer.avatarUrl }] : []); return; }
    const cached = mentionCache.get(id);
    if (cached && Date.now() - cached.at < MENTION_TTL_MS) { setMentionPool(cached.members); return; }
    let active = true;
    api.community(id).then(detail => {
      const members = detail.members.filter(m => m.profile?.username).map(m => ({ userId: m.userId, username: m.profile!.username!, avatarUrl: m.profile!.avatarUrl }));
      mentionCache.set(id, { at: Date.now(), members });
      if (active) setMentionPool(members);
    }).catch(() => {});
    return () => { active = false; };
  }, [mentionActive, id, conversation?.kind, conversation?.peer?.userId]);
  const mentionMatches = mention && mentionPool ? mentionPool.filter(m => m.userId !== me && m.username.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 8) : [];
  const insertMention = (username: string) => {
    if (!mention) return;
    const insert = '@' + username + ' ';
    const rest = draft.slice(selection.start).replace(/^[A-Za-z0-9_]*\s?/, '');
    const cursor = mention.start + insert.length;
    setDraft(draft.slice(0, mention.start) + insert + rest);
    setSelection({ start: cursor, end: cursor });
    setForcedSelection({ start: cursor, end: cursor });
  };
  // Apply the cursor after an insert once, then hand it back to the keyboard.
  useEffect(() => { if (!forcedSelection) return; const timer = setTimeout(() => setForcedSelection(null), 50); return () => clearTimeout(timer); }, [forcedSelection]);
  // Compact bubbles: the time sits at the end of the last line (text, "Message
  // deleted" or the reactions row), with invisible spacing reserved for it.
  const metaLabel = (message: LocalMessage) => `${message.editedAt ? 'edited · ' : ''}${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${message.senderId === me && !isChannel ? message.status === 'pending' ? '  ◷' : message.status === 'failed' ? '  ⚠ tap & hold' : '  ✓' : ''}`;
  const hasReactions = (message: LocalMessage) => !message.deleted && Boolean(extras?.reactions[message.id]?.counts.length);
  const inlineMeta = (message: LocalMessage) => message.deleted || hasReactions(message) || (Boolean(message.text) && messageLength(message.text) <= 700 && message.text.split('\n').length <= 12);
  const metaSpacer = (message: LocalMessage) => <Text style={styles.metaSpacer}>{'\u00A0'.repeat(Math.ceil(metaLabel(message).length * 1.6) + 2)}</Text>;
  const react = (messageId: string, emoji: string) => {
    const current = extras?.reactions[messageId];
    const next = current?.mine === emoji ? null : emoji;
    const put = (value: ReactionState) => setExtras(prev => { const base = prev ?? EMPTY_EXTRAS; return { ...base, reactions: { ...base.reactions, [messageId]: value } }; });
    put(applyReaction(current, next));
    api.setMessageReaction(messageId, next).then(put).catch(error => { put(current ?? { counts: [], mine: null }); kivoAlert('Reaction', error instanceof Error ? error.message : 'Could not react.'); });
  };
  const setPin = (messageId: string | null, pin = true) => {
    api.setConversationPin(id, messageId, pin).then(result => { setPinIndex(0); setExtras(prev => ({ ...(prev ?? EMPTY_EXTRAS), pinned: result.pinned ? { ...result.pinned, status: 'sent' } : null, pins: asPins(result.pins, result.pinned) })); })
      .catch(error => kivoAlert(messageId ? 'Pin message' : 'Unpin message', error instanceof Error ? error.message : 'Action failed.'));
  };
  // Synchronous guard: a double tap must never send (or save an edit) twice.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let lastDay = '';
    messages.forEach((message, index) => {
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        out.push({ type: 'day', key: 'day-' + day, label: day === new Date().toDateString() ? 'Today' : new Date(message.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) });
      }
      if (message.id === firstUnreadId) out.push({ type: 'unread', key: 'unread-divider' });
      // Polls are standalone cards: always show their real author identity in groups/channels,
      // even when normal sender grouping would hide it. Keep regular messages grouped.
      const pollAuthor = Boolean(message.poll && !message.deleted && conversation?.kind !== 'dm');
      out.push({ type: 'message', key: message.id, message,
        showName: conversation?.kind !== 'dm' && (pollAuthor || (message.senderId !== me && messages[index - 1]?.senderId !== message.senderId)),
        showAvatar: conversation?.kind !== 'dm' && (pollAuthor || (conversation?.kind === 'group' && message.senderId !== me && messages[index + 1]?.senderId !== message.senderId)) });
    });
    return out;
  }, [messages, conversation?.kind, me, firstUnreadId]);
  /** Scroll to a message and flash it; false when it isn't in the loaded history. */
  const jumpToMessage = (messageId: string, what = 'Pinned message') => {
    if (!scrollToItem(messageId)) { kivoAlert(what, 'This message is older than the history on this phone.'); return false; }
    atBottom.current = false; setHighlightedId(messageId); return true;
  };
  const scrollToItem = (key: string, animated = true) => {
    const index = items.findIndex(item => item.key === key);
    if (index < 0) return false;
    list.current?.scrollToIndex({ index, animated, viewPosition: 0.15 });
    return true;
  };

  const send = async () => {
    if (sendingRef.current) return;
    const text = draft;
    if (!text.trim() && !verifiedTokenAttachment) return;
    if (tokenAttachmentOpen && !verifiedTokenAttachment && !text.trim()) { kivoAlert('Token attachment', 'Paste a token with a live market first.'); return; }
    if (overLimit) {
      kivoAlert('Message', verifiedSender ? 'This message is too long.' : `Messages are limited to ${charLimit} characters. Blue Star accounts can send up to ${messageCharLimit(true).toLocaleString()} characters.`);
      return;
    }
    const editingId = editingMessageId;
    sendingRef.current = true;
    setSending(true);
    try {
      if (editingId) {
        await editMessage(id, editingId, text);
        setEditingMessageId(null);
        setDraft('');
      } else {
        await sendText(id, text, replyingTo?.id, verifiedTokenAttachment ?? undefined);
        setDraft('');
        setReplyingTo(null);
        setVerifiedTokenAttachment(null);
        setTokenAttachmentOpen(false);
      }
    } catch (error) { kivoAlert(editingId ? 'Edit message' : 'Message', error instanceof Error ? error.message : 'Not sent.'); }
    finally { sendingRef.current = false; setSending(false); }
  };
  const attach = async () => {
    try {
      const photo = await pickCompressedPhoto();
      // Keep the caption when the photo fails: photos can't be retried, only re-sent.
      if (photo && await sendImage(id, photo, draft)) setDraft('');
    } catch (error) { kivoAlert('Photo', error instanceof Error ? error.message : 'Photo not sent.'); }
  };
  const onLongPress = (message: LocalMessage) => {
    if (message.status === 'failed') {
      kivoAlert('Not sent', message.error ?? 'This message was not delivered.', [
        { text: 'Discard', style: 'destructive', onPress: () => discardMessage(id, message.id) },
        ...(!message.media ? [{ text: 'Retry', onPress: () => { void retryMessage(id, message.id); } }] : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
      return;
    }
    if (message.status !== 'sent' || message.deleted) return;
    // Match Web: show quick reactions in the same message-options sheet.
    setOptionsMessage(message);
    setOptionsMenu([
      ...(message.text ? [
        { text: 'Copy message', onPress: () => { Clipboard.setString(message.text); kivoAlert('Copied', 'Message copied to clipboard.'); } },
        { text: 'Select text', onPress: () => setSelectedTextMessageId(message.id) },
      ] : []),
      ...(canPost ? [{ text: 'Reply', onPress: () => { setEditingMessageId(null); setReplyingTo(message); } }] : []),
      ...(canPin ? (() => { const isPinned = pins.some(p => p.id === message.id); return [{ text: isPinned ? 'Unpin message' : 'Pin message', onPress: () => setPin(message.id, !isPinned) }]; })() : []),
      ...(message.senderId === me ? [{ text: 'Edit message', onPress: () => { setReplyingTo(null); setEditingMessageId(message.id); setDraft(message.text); } }] : []),
      { text: 'Forward message', onPress: () => setForwardingMessage(message) },
      ...(message.senderId === me || canModerate ? [{ text: 'Delete message', style: 'destructive' as const, onPress: () => kivoAlert('Delete message', 'Delete this message for everyone?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteForEveryone(id, message.id).catch(error => kivoAlert('Delete', error instanceof Error ? error.message : 'Could not delete.')) },
      ]) }] : []),
      ...(conversation?.kind === 'dm' && message.senderId !== me && conversation.peer?.userId === message.senderId ? [{
        text: 'Block / unblock user',
        onPress: () => { void api.blockedUsers().then(blocked => {
          const isBlocked = blocked.includes(message.senderId);
          kivoAlert(isBlocked ? 'Unblock user?' : 'Block user?', isBlocked ? 'They will be able to message you again.' : 'They will no longer be able to send you direct messages. You can unblock them later.', [
            { text: 'Cancel', style: 'cancel' },
            { text: isBlocked ? 'Unblock' : 'Block', style: isBlocked ? 'default' as const : 'destructive' as const, onPress: () => (isBlocked ? api.unblockUser(message.senderId) : api.blockUser(message.senderId)).then(() => kivoAlert('Privacy', isBlocked ? 'User unblocked.' : 'User blocked.')).catch(error => kivoAlert('Privacy', error instanceof Error ? error.message : 'Action failed.')) },
          ]);
        }).catch(error => kivoAlert('Privacy', error instanceof Error ? error.message : 'Could not load block status.')); },
      }] : []),
      ...(canModerate && conversation?.kind === 'group' && message.senderId !== me ? [{
        text: 'Restrict / restore posting',
        onPress: () => { void api.community(id).then(detail => {
          const member = detail.members.find(item => item.userId === message.senderId);
          if (!member || member.role !== 'member') { kivoAlert('Moderation', 'Only regular members can be restricted.'); return; }
          const restricted = Boolean(member.restricted);
          kivoAlert(restricted ? 'Restore posting?' : 'Restrict posting?', restricted ? 'Allow this member to send messages again.' : 'This member will not be able to send messages in this group.', [
            { text: 'Cancel', style: 'cancel' },
            { text: restricted ? 'Restore' : 'Restrict', style: restricted ? 'default' as const : 'destructive' as const, onPress: () => api.setMemberRestricted(id, message.senderId, !restricted).then(() => kivoAlert('Moderation', restricted ? 'Posting restored.' : 'Member restricted.')).catch(error => kivoAlert('Moderation', error instanceof Error ? error.message : 'Action failed.')) },
          ]);
        }).catch(error => kivoAlert('Moderation', error instanceof Error ? error.message : 'Could not load member.')); },
      }] : []),
    ]);
  };

  const title = conversation?.title ?? 'Conversation';
  const subtitle = !state.online ? 'Offline — will sync when back' : conversation?.kind === 'dm' ? (conversation.peer ? shortWallet(conversation.peer.address) : 'Direct message') : isChannel ? 'Channel' : 'Group';

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back"><Text style={styles.back}>‹</Text></Pressable>
        <Pressable onPress={() => conversation?.kind === 'dm' && conversation.peer?.userId ? onOpenPerson?.(conversation.peer.userId) : conversation && conversation.kind !== 'dm' ? onOpenInfo?.(id, conversation.kind) : undefined} accessibilityLabel={conversation?.kind === 'dm' ? 'View user profile' : 'Open conversation info'}>
          <Avatar name={title} uri={conversation?.avatarUrl} size={40} verified={conversation?.kind === 'dm' ? peerVerified : conversation?.isVerified === true} />
        </Pressable>
        <Pressable style={styles.headerCopy} disabled={!conversation} onPress={() => conversation?.kind === 'dm' && conversation.peer?.userId ? onOpenPerson?.(conversation.peer.userId) : conversation && conversation.kind !== 'dm' ? onOpenInfo?.(id, conversation.kind) : undefined}>
          <View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{title}</Text>{conversation?.kind !== 'dm' && (conversation?.isVerified === true) ? <Text accessibilityLabel="Verified community" style={styles.verifiedBadge}>★</Text> : null}</View>
          <Text style={styles.status}>{subtitle}</Text>
        </Pressable>
        {conversation?.kind === 'dm' && conversation.peer?.userId && <Pressable onPress={() => {
          const peerId = conversation.peer!.userId;
          void api.blockedUsers().then(blocked => {
            const isBlocked = blocked.includes(peerId);
            kivoAlert(isBlocked ? 'Unblock user?' : 'Block user?', isBlocked ? 'They will be able to message you again.' : 'They will no longer be able to send you direct messages.', [
              { text: 'Cancel', style: 'cancel' },
              { text: isBlocked ? 'Unblock' : 'Block', style: isBlocked ? 'default' as const : 'destructive' as const, onPress: () => (isBlocked ? api.unblockUser(peerId) : api.blockUser(peerId)).then(() => kivoAlert('Privacy', isBlocked ? 'User unblocked.' : 'User blocked.')).catch(error => kivoAlert('Privacy', error instanceof Error ? error.message : 'Action failed.')) },
            ]);
          }).catch(error => kivoAlert('Privacy', error instanceof Error ? error.message : 'Could not load privacy settings.'));
        }} hitSlop={10} accessibilityLabel="Privacy and blocking"><Text style={styles.info}>⊘</Text></Pressable>}
        {conversation && conversation.kind !== 'dm' && <Pressable onPress={() => onOpenInfo?.(id, conversation.kind as 'group' | 'channel')} hitSlop={10}><Text style={styles.info}>ⓘ</Text></Pressable>}
      </View>
      {pinned ? (
        <Pressable style={styles.pinnedBar} onPress={() => { jumpToMessage(pinned.id); setPinIndex((shownPinIndex + 1) % pins.length); }} accessibilityRole="button" accessibilityLabel="Go to pinned message">
          {pins.length > 1 ? <PinIndicator count={pins.length} position={pins.length - 1 - shownPinIndex} /> : <View style={styles.pinnedAccent} />}
          <View style={styles.pinnedCopy}>
            <Text style={styles.pinnedLabel}>{pins.length > 1 && shownPinIndex > 0 ? `Pinned Message #${pins.length - shownPinIndex}` : 'Pinned Message'}</Text>
            <Text style={styles.pinnedText} numberOfLines={1}>{pinnedPreview(pinned)}</Text>
          </View>
          {pinned.media && !pinned.deleted ? <Image source={{ uri: pinned.media.url.split('?')[0], headers: api.mediaHeaders(pinned.media.url.split('?')[0]) }} style={styles.pinnedThumb} resizeMode="cover" /> : null}
          <Pressable hitSlop={10} onPress={() => setPinsOpen(true)} accessibilityRole="button" accessibilityLabel="All pinned messages"><Text style={styles.pinnedListIcon}>☰</Text></Pressable>
        </Pressable>
      ) : null}
      <View style={styles.listWrap}>
      <FlatList
        ref={list}
        data={items}
        keyExtractor={item => item.key}
        contentContainerStyle={styles.messages}
        extraData={listExtra}
        onScrollToIndexFailed={info => {
          // Rows far above are not rendered yet: move near them, then retry once they are.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          if (jumpRetries.current++ < 6) setTimeout(() => list.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.15 }), 120);
        }}
        onContentSizeChange={() => {
          const added = Math.max(0, messages.length - previousMessageCount.current);
          previousMessageCount.current = messages.length;
          if (pendingJump.current) {
            // Open at the first unread message instead of the bottom.
            if (scrollToItem('unread-divider', false)) { pendingJump.current = false; jumpRetries.current = 0; }
          } else if (atBottom.current) {
            list.current?.scrollToEnd({ animated: false });
            setUnseenMessages(0);
          } else if (added > 0) {
            setUnseenMessages(count => count + added);
          }
        }}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const nearBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          atBottom.current = nearBottom;
          if (nearBottom) setUnseenMessages(0);
        }}
        scrollEventThrottle={100}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        ListEmptyComponent={<Text style={styles.emptyText}>{isChannel ? 'No posts yet.' : 'No messages yet. Say hello 👋'}</Text>}
        renderItem={({ item }) => {
          if (item.type === 'day') return <View style={styles.day}><Text style={styles.dayText}>{item.label}</Text></View>;
          if (item.type === 'unread') return <View style={styles.unreadDivider} accessibilityRole="header"><View style={styles.unreadLine} /><Text style={styles.unreadText}>New messages</Text><View style={styles.unreadLine} /></View>;
          const { message } = item;
          const mine = message.senderId === me && !isChannel;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine, conversation?.kind === 'group' && !mine && styles.bubbleRowGroupIncoming]}>
              {conversation?.kind !== 'dm' && item.showAvatar && !mine ? <View style={styles.avatarColumn}><Avatar name={displayName(message.senderId)} uri={state.profiles[message.senderId]?.avatarUrl} size={30} verified={verifiedSenders.has(message.senderId)} /></View> : null}
              <Pressable onLongPress={selectedTextMessageId === message.id ? undefined : () => onLongPress(message)} style={[styles.bubble, mine && styles.bubbleMine, isChannel && styles.post, message.deleted && styles.deleted, unreadMentionSet.has(message.id) && styles.bubbleMention, message.id === highlightedId && styles.bubbleHighlight]}>
                {message.forwardedFrom ? <Text style={styles.forwardedLabel}>↪ Forwarded from {displayName(message.forwardedFrom)}</Text> : null}
                {item.showName && <Pressable onPress={() => onOpenPerson?.(message.senderId)} disabled={!onOpenPerson} hitSlop={6}><View style={styles.senderLine}><Text style={styles.sender}>{message.senderId === me && message.poll ? '@' + (profile.username || 'You') : displayName(message.senderId)}</Text>{verifiedSenders.has(message.senderId) ? <Text accessibilityLabel="Blue Star verified profile" style={styles.senderVerifiedBadge}>★</Text> : null}</View></Pressable>}
                {message.token && <TokenAttachmentCard token={message.token} compact onPress={onOpenToken ? () => onOpenToken(message.token!) : undefined} />}
                {message.poll && !message.deleted && <ChatPollCard messageId={message.id} onError={message=>kivoAlert('Poll',message)} />}
                {message.media && <MessagePhoto uri={message.media.url} width={message.media.width} height={message.media.height} onOpen={() => setViewing(message)} onLongPress={() => onLongPress(message)} />}
                {message.replyTo && !message.deleted ? (() => {
                  const quoted = messages.find(item => item.id === message.replyTo);
                  return <View style={styles.replyQuote}><Text style={styles.replyQuoteName} numberOfLines={1}>{quoted ? displayName(quoted.senderId) : 'Reply'}</Text><Text style={styles.replyQuoteText} numberOfLines={2}>{quoted ? (quoted.deleted ? 'Message deleted' : quoted.text || '📷 Photo') : 'Original message is not available'}</Text></View>;
                })() : null}
                {message.deleted ? <Text style={styles.deletedText}>Message deleted{inlineMeta(message) && !hasReactions(message) ? metaSpacer(message) : null}</Text> : message.text ? (() => {
                  // Long messages collapse after ~12 lines so one post can't take over the chat.
                  const long = messageLength(message.text) > 700 || message.text.split('\n').length > 12;
                  const open = expanded[message.id] === true;
                  return <View>
                    <Text selectable={selectedTextMessageId === message.id} style={[styles.text, isChannel && styles.postText]} numberOfLines={long && !open ? 12 : undefined}>{renderLinkedText(message.text, myUsername, openMention)}{inlineMeta(message) && !hasReactions(message) ? metaSpacer(message) : null}</Text>
                    {long ? <Pressable hitSlop={6} onPress={() => setExpanded(prev => ({ ...prev, [message.id]: !open }))}><Text style={styles.showMore}>{open ? 'Show less' : 'Show more'}</Text></Pressable> : null}
                  </View>;
                })() : null}
                {(() => {
                  const reactions = extras?.reactions[message.id];
                  if (!reactions?.counts.length || message.deleted) return null;
                  return <View style={[styles.reactions, inlineMeta(message) && { paddingRight: metaLabel(message).length * 6 + 8 }]}>{reactions.counts.map(entry => (
                    <Pressable key={entry.emoji} disabled={!canReact || message.status !== 'sent'} onPress={() => react(message.id, entry.emoji)} style={[styles.reactionChip, reactions.mine === entry.emoji && styles.reactionChipMine]} accessibilityRole="button" accessibilityState={{ selected: reactions.mine === entry.emoji }} accessibilityLabel={`${entry.emoji} ${entry.count}${reactions.mine === entry.emoji ? ', your reaction' : ''}`}>
                      <Text style={[styles.reactionChipText, reactions.mine === entry.emoji && styles.reactionChipTextMine]}>{entry.emoji} {entry.count}</Text>
                    </Pressable>
                  ))}</View>;
                })()}
                <Text style={[styles.meta, inlineMeta(message) && styles.metaInline]}>{metaLabel(message)}</Text>
              </Pressable>
              {conversation?.kind !== 'dm' && item.showAvatar && mine && message.poll && <View style={[styles.avatarColumn, { marginRight: 0, marginLeft: 8 }]}><Avatar name={'@' + (profile.username || 'You')} uri={profile.avatarUri ?? state.profiles[message.senderId]?.avatarUrl} size={30} verified={verifiedSenders.has(message.senderId)} /></View>}
            </View>
          );
        }}
      />

        {unseenMessages > 0 && (
          <Pressable style={styles.jumpLatest} onPress={() => { pendingJump.current = false; list.current?.scrollToEnd({ animated: true }); atBottom.current = true; setUnseenMessages(0); }} accessibilityLabel={`Jump to ${unseenMessages} new messages`}>
            <Text style={styles.jumpArrow}>↓</Text>
            <Text style={styles.jumpCountText}>{unseenMessages > 999 ? '999+' : unseenMessages} new</Text>
          </Pressable>
        )}
        {unreadMentionIds.length > 0 && (
          <Pressable style={[styles.jumpMention, unseenMessages > 0 && styles.jumpMentionStacked]} onPress={() => { const next = unreadMentionIds[0]; jumpToMessage(next, 'Mention'); markMentionsSeen([next]); }} accessibilityRole="button" accessibilityLabel={`Go to ${unreadMentionIds.length} unread mention${unreadMentionIds.length === 1 ? '' : 's'}`}>
            <Text style={styles.jumpMentionText}>@</Text>
            <View style={styles.jumpMentionBadge}><Text style={styles.jumpMentionBadgeText}>{unreadMentionIds.length > 99 ? '99+' : unreadMentionIds.length}</Text></View>
          </Pressable>
        )}
      </View>
      {canPost ? (
        <View>
        {replyingTo && !editingMessageId && <View style={styles.editingBar}><View style={{ flex: 1, marginRight: 12 }}><Text style={styles.editingLabel}>Replying to {displayName(replyingTo.senderId)}</Text><Text style={styles.replyBarText} numberOfLines={1}>{replyingTo.text || '📷 Photo'}</Text></View><Pressable onPress={() => setReplyingTo(null)} hitSlop={10}><Text style={styles.editingCancel}>Cancel</Text></Pressable></View>}
        {editingMessageId && <View style={styles.editingBar}><Text style={styles.editingLabel}>Editing message</Text><Pressable onPress={() => { setEditingMessageId(null); setDraft(''); }}><Text style={styles.editingCancel}>Cancel</Text></Pressable></View>}
        {showCounter ? (
          <View style={styles.limitRow} accessibilityLiveRegion="polite">
            <Text style={[styles.limitCount, overLimit && styles.limitOver]}>{draftLength.toLocaleString()}/{charLimit.toLocaleString()}</Text>
            {overLimit && !verifiedSender ? <Text style={styles.limitHint}>★ Get Verified for up to {messageCharLimit(true).toLocaleString()} characters</Text> : null}
          </View>
        ) : null}
        {mentionMatches.length > 0 && <ScrollView style={styles.mentionList} keyboardShouldPersistTaps="always" accessibilityLabel="Mention someone">
          {mentionMatches.map(m => <Pressable key={m.userId} onPress={() => insertMention(m.username)} style={({ pressed }) => [styles.mentionRow, pressed && styles.mentionRowPressed]} accessibilityRole="button" accessibilityLabel={`Mention @${m.username}`}>
            <Avatar name={m.username} uri={m.avatarUrl} size={30} /><Text style={styles.mentionName} numberOfLines={1}>@{m.username}</Text>
          </Pressable>)}
        </ScrollView>}
        {tokenAttachmentOpen && <TokenAttachmentPicker onChange={setVerifiedTokenAttachment} onClose={() => setTokenAttachmentOpen(false)} />}
        <Modal visible={pollComposerOpen} transparent animationType="slide" onRequestClose={()=>setPollComposerOpen(false)}><KeyboardAvoidingView style={styles.modalShade} behavior={Platform.OS==='ios'?'padding':'height'}><View style={styles.pollSheet}><View style={styles.senderLine}><Text style={styles.sheetTitle}>Create a poll</Text><Pressable onPress={()=>setPollComposerOpen(false)}><Text style={styles.attachText}>✕</Text></Pressable></View><ScrollView keyboardShouldPersistTaps="handled"><TextInput value={pollQuestion} onChangeText={setPollQuestion} maxLength={200} placeholder="Ask a question" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.pollInput}/><TextInput value={pollDescription} onChangeText={setPollDescription} maxLength={500} placeholder="Description (optional)" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.pollInput}/><Text style={styles.sender}>Options</Text>{pollOptions.map((value,index)=><View key={index} style={{flexDirection:'row',alignItems:'center',gap:8}}><TextInput value={value} onChangeText={next=>setPollOptions(old=>old.map((v,i)=>i===index?next:v))} maxLength={100} placeholder={'Option '+(index+1)} placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.pollInput,{flex:1}]}/>{pollOptions.length>2&&<Pressable onPress={()=>setPollOptions(old=>old.filter((_,i)=>i!==index))}><Text style={{color:'#E57373'}}>✕</Text></Pressable>}</View>)}<Pressable disabled={pollOptions.length>=12} onPress={()=>setPollOptions(old=>[...old,''])}><Text style={styles.attachmentLabel}>＋ Add option</Text></Pressable><Text style={[styles.sender,{marginTop:12}]}>Settings</Text>{([{key:'allowMultiple',label:'Allow multiple answers'},{key:'showVoters',label:'Show voter names'},{key:'allowAddingOptions',label:'Allow adding options'},{key:'allowRevoting',label:'Allow revoting'},{key:'shuffleOptions',label:'Shuffle options'}] as const).map(item=><Pressable key={item.key} onPress={()=>setPollSettings(old=>({...old,[item.key]:!old[item.key]}))} style={styles.pollSettingRow}><Text style={styles.pollLabel}>{item.label}</Text><Text style={{color:pollSettings[item.key]?kivoTheme.colors.accent:kivoTheme.colors.textMuted,fontWeight:'900'}}>{pollSettings[item.key]?'ON':'OFF'}</Text></Pressable>)}<Text style={[styles.sender,{marginTop:12}]}>Duration</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8,marginVertical:10}}>{POLL_DURATION_OPTIONS.map(item=><Pressable key={String(item.hours)} onPress={()=>setPollDuration(item.hours)} style={[styles.pollDuration,pollDuration===item.hours&&styles.pollDurationOn]}><Text style={{color:pollDuration===item.hours?kivoTheme.colors.accent:kivoTheme.colors.text,fontSize:12}}>{item.label}</Text></Pressable>)}</View></ScrollView><View style={styles.pollActions}><Pressable onPress={()=>setPollComposerOpen(false)}><Text style={styles.attachmentLabel}>Cancel</Text></Pressable><Pressable disabled={pollSending} onPress={()=>{if(pollSending)return;let question:string,description:string,options:string[];try{question=normalizePollQuestion(pollQuestion);description=normalizePollDescription(pollDescription);options=normalizePollOptions(pollOptions);}catch(e){kivoAlert('Poll',e instanceof Error?e.message:'Check poll details.');return;}setPollSending(true);void (async()=>{try{await sendPoll(id,{question,description,options,settings:{...pollSettings},endsAt:pollDuration===null?null:Date.now()+pollDuration*3_600_000});setPollComposerOpen(false);}catch(e){kivoAlert('Poll',e instanceof Error?e.message:'Could not send poll.');}finally{setPollSending(false);}})();}} style={styles.pollSend}><Text style={styles.pollSendText}>{pollSending?'Sending…':'Send poll'}</Text></Pressable></View></View></KeyboardAvoidingView></Modal>
        <View style={styles.composerArea}>
          {attachmentMenuOpen && <View style={styles.attachmentMenu} accessibilityLabel="Attachment options">
            <Pressable onPress={() => { setAttachmentMenuOpen(false); void attach(); }} style={({ pressed }) => [styles.attachmentTile, pressed && styles.attachmentTilePressed]} accessibilityRole="button" accessibilityLabel="Attach photo">
              <AttachmentSymbol kind="photo" color={kivoTheme.colors.accent} />
              <Text style={styles.attachmentLabel}>Photo</Text>
            </Pressable>
            {(conversation?.kind === 'group' || conversation?.kind === 'channel') && <Pressable onPress={() => { setAttachmentMenuOpen(false); setPollQuestion(''); setPollDescription(''); setPollOptions(['','']); setPollSettings({...DEFAULT_POLL_SETTINGS}); setPollDuration(null); setPollComposerOpen(true); }} style={({ pressed }) => [styles.attachmentTile, pressed && styles.attachmentTilePressed]} accessibilityRole="button" accessibilityLabel="Create poll">
              <AttachmentSymbol kind="poll" color={kivoTheme.colors.accent} />
              <Text style={styles.attachmentLabel}>Poll</Text>
            </Pressable>}
            <Pressable onPress={() => { setAttachmentMenuOpen(false); setTokenAttachmentOpen(true); }} style={({ pressed }) => [styles.attachmentTile, pressed && styles.attachmentTilePressed]} accessibilityRole="button" accessibilityLabel="Attach token card">
              <AttachmentSymbol kind="token" color={kivoTheme.colors.accent} />
              <Text style={styles.attachmentLabel}>Token card</Text>
            </Pressable>
          </View>}
          <View style={styles.composer}>
            <Pressable onPress={() => { setTokenAttachmentOpen(false); setAttachmentMenuOpen(value => !value); }} hitSlop={8} style={styles.attach} accessibilityLabel="Attachments" accessibilityState={{ expanded: attachmentMenuOpen }}><Text style={styles.attachText}>＋</Text></Pressable>
            <TextInput value={draft} onChangeText={setDraft} selection={forcedSelection ?? undefined} onSelectionChange={event => setSelection(event.nativeEvent.selection)} placeholder={editingMessageId ? 'Edit message' : 'Message'} placeholderTextColor={kivoTheme.colors.textMuted} multiline maxLength={messageCharLimit(true) * 2} style={styles.input} />
            <Pressable disabled={(!draft.trim() && !verifiedTokenAttachment) || sending} onPress={send} style={[styles.send, ((!draft.trim() && !verifiedTokenAttachment) || overLimit || sending) && styles.sendDisabled]} accessibilityLabel={editingMessageId ? 'Save edit' : 'Send'}><Text style={styles.sendText}>{editingMessageId ? '✓' : '➤'}</Text></Pressable>
          </View>
        </View>
        </View>
      ) : (
        <View style={styles.readonly}><Text style={styles.readonlyText}>{conversation?.kind === 'group' ? '📢 Only admins can send messages.' : '📢 Only the channel owner and admins can post.'}</Text></View>
      )}
      <KivoModal visible={pinsOpen} animationType="slide" onRequestClose={() => setPinsOpen(false)}>
        <View style={styles.pinsScreen}>
          <View style={styles.pinsHeader}>
            <Pressable onPress={() => setPinsOpen(false)} hitSlop={10} accessibilityLabel="Close"><Text style={styles.pinsBack}>‹</Text></Pressable>
            <Text style={styles.pinsTitle}>{pins.length} Pinned {pins.length === 1 ? 'Message' : 'Messages'}</Text>
            {canPin && pins.length ? <Pressable hitSlop={8} onPress={() => kivoAlert('Unpin all messages', `Remove all ${pins.length} pinned messages for everyone?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Unpin all', style: 'destructive', onPress: () => { setPinsOpen(false); setPin(null); } },
            ])}><Text style={styles.pinsUnpinAll}>Unpin all</Text></Pressable> : null}
          </View>
          <ScrollView contentContainerStyle={styles.pinsList}>
            {pins.map(p => (
              <Pressable key={p.id} style={({ pressed }) => [styles.pinItem, pressed && styles.pinItemPressed]} onPress={() => { setPinsOpen(false); setTimeout(() => jumpToMessage(p.id), 250); }} accessibilityRole="button">
                <View style={styles.pinItemHead}>
                  <Text style={styles.sender} numberOfLines={1}>{displayName(p.senderId)}</Text>
                  <Text style={styles.meta}>{new Date(p.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
                </View>
                {p.deleted ? <Text style={styles.deletedText}>Message deleted</Text> : <>
                  {p.token ? <TokenAttachmentCard token={p.token} compact /> : null}
                  {p.media ? <MessagePhoto uri={p.media.url} width={p.media.width} height={p.media.height} /> : null}
                  {p.text ? <Text style={styles.text} numberOfLines={8}>{renderLinkedText(p.text, myUsername, username => { setPinsOpen(false); openMention(username); })}</Text> : null}
                </>}
                {canPin ? <Pressable hitSlop={8} onPress={() => setPin(p.id, false)} style={styles.pinItemUnpin} accessibilityRole="button" accessibilityLabel="Unpin message"><Text style={styles.pinsUnpinAll}>Unpin</Text></Pressable> : null}
              </Pressable>
            ))}
          </ScrollView>
          <Pressable onPress={() => setPinsOpen(false)} style={styles.pinsHide} accessibilityRole="button"><Text style={styles.pinsHideText}>Hide pinned messages</Text></Pressable>
        </View>
      </KivoModal>
      <KivoModal transparent visible={!!forwardingMessage} animationType="fade" onRequestClose={() => setForwardingMessage(null)}>
        <View style={styles.forwardOverlay}>
          <View style={styles.forwardSheet}>
            <View style={styles.forwardHeader}>
              <Text style={styles.forwardTitle}>Forward to…</Text>
              <Pressable onPress={() => setForwardingMessage(null)} hitSlop={10}><Text style={styles.forwardCancel}>Cancel</Text></Pressable>
            </View>
            <ScrollView style={styles.forwardList} keyboardShouldPersistTaps="handled">
              {state.conversations.filter(c => c.id !== id && (c.kind === 'dm' || c.myRole === 'owner' || c.myRole === 'admin' || (c.kind === 'group' && !c.onlyAdminsPost))).map(c => (
                <Pressable key={c.id} style={styles.forwardDestination} onPress={() => {
                  const selected = forwardingMessage;
                  setForwardingMessage(null);
                  if (selected) void forwardMessage(id, selected.id, c.id).then(() => kivoAlert('Forwarded', 'Message sent to ' + c.title + '.')).catch(error => kivoAlert('Forward', error instanceof Error ? error.message : 'Could not forward.'));
                }}>
                  <Avatar name={c.title} uri={c.avatarUrl} size={38} verified={c.kind !== 'dm' && (c.isVerified === true || (c.kind === 'channel' && false))} />
                  <View style={styles.forwardDestinationCopy}>
                    <View style={styles.forwardDestinationTitleLine}><Text style={styles.forwardDestinationTitle} numberOfLines={1}>{c.title}</Text>{c.kind !== 'dm' && (c.isVerified === true || (c.kind === 'channel' && false)) ? <Text accessibilityLabel="Verified community" style={styles.forwardVerifiedBadge}>★</Text> : null}</View>
                    <Text style={styles.forwardDestinationKind}>{c.kind === 'dm' ? 'Direct message' : c.kind === 'group' ? 'Group' : 'Channel'}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </KivoModal>
      <BottomSheet visible={!!optionsMenu} onClose={() => { setOptionsMenu(null); setOptionsMessage(null); }}>
        <Text style={styles.sheetTitle}>Message options</Text>
        {optionsMessage && canReact && (
          <View style={styles.webParityReactionSection}>
            <Text style={styles.webParityReactionLabel}>React</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.webParityReactionRow}>
              {REACTIONS.map(emoji => {
                const selected = extras?.reactions[optionsMessage.id]?.mine === emoji;
                return <Pressable key={emoji} style={[styles.reactionOption, selected && styles.reactionOptionMine]} accessibilityRole="button" accessibilityLabel={`React with ${emoji}`} accessibilityState={{ selected }} onPress={() => {
                  const target = optionsMessage;
                  setOptionsMenu(null); setOptionsMessage(null);
                  if (target) react(target.id, emoji);
                }}><Text style={styles.reactionOptionText}>{emoji}</Text></Pressable>;
              })}
            </ScrollView>
          </View>
        )}
        {(optionsMenu ?? []).map(item => (
          <Pressable key={item.text} style={styles.sheetRow} accessibilityRole="button" onPress={() => { setOptionsMenu(null); setOptionsMessage(null); item.onPress?.(); }}>
            <Text style={[styles.sheetRowText, item.style === 'destructive' && styles.sheetRowDanger]}>{item.text}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.sheetRow} accessibilityRole="button" onPress={() => { setOptionsMenu(null); setOptionsMessage(null); }}><Text style={styles.sheetCancel}>Cancel</Text></Pressable>
      </BottomSheet>
      <BottomSheet visible={!!reactingTo} onClose={() => setReactingTo(null)}>
        <Text style={styles.sheetTitle}>React</Text>
        <View style={styles.reactionPicker}>
          {REACTIONS.map(emoji => {
            const selected = reactingTo ? extras?.reactions[reactingTo.id]?.mine === emoji : false;
            return <Pressable key={emoji} style={[styles.reactionOption, selected && styles.reactionOptionMine]} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`React with ${emoji}`} onPress={() => { const target = reactingTo; setReactingTo(null); if (target) react(target.id, emoji); }}><Text style={styles.reactionOptionText}>{emoji}</Text></Pressable>;
          })}
        </View>
        <Pressable style={styles.sheetRow} accessibilityRole="button" onPress={() => setReactingTo(null)}><Text style={styles.sheetCancel}>Cancel</Text></Pressable>
      </BottomSheet>
      <PhotoViewer
        uri={viewing?.media?.url ?? null}
        title={viewing ? displayName(viewing.senderId) : undefined}
        subtitle={viewing ? new Date(viewing.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : undefined}
        onClose={() => setViewing(null)}
        onReply={viewing && canPost ? () => { const target = viewing; setEditingMessageId(null); setReplyingTo(target); } : undefined}
      />
    </KeyboardAvoidingView>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.backgroundDeep },
  header: { minHeight: 64, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.background },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerCopy: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  verifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 11, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 17, height: 17, borderRadius: 9, overflow: 'hidden' },
  name: { color: c.text, fontSize: 16, fontWeight: '800' },
  status: { color: c.textMuted, fontSize: 11.5, marginTop: 2 },
  info: { color: c.cream, fontSize: 20, paddingHorizontal: 6 },
  listWrap: { flex: 1, position: 'relative' },
  messages: { padding: 10, paddingBottom: 16, gap: 3 },
  editingBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 7, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border },
  editingLabel: { color: c.accent, fontSize: 12.5, fontWeight: '800' },
  editingCancel: { color: c.textMuted, fontSize: 12.5, fontWeight: '700' },
  replyBarText: { color: c.textMuted, fontSize: 12.5, marginTop: 2 },
  replyQuote: { borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 8, marginBottom: 6, opacity: 0.9 },
  replyQuoteName: { color: c.accent, fontSize: 12, fontWeight: '800' },
  replyQuoteText: { color: c.textMuted, fontSize: 12.5 },
  sheetTitle: { color: c.text, fontSize: 18, fontWeight: '800', marginBottom: 6 },
  sheetRow: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: c.border },
  sheetRowText: { color: c.text, fontSize: 16, fontWeight: '700' },
  sheetRowDanger: { color: '#E0443E' },
  sheetCancel: { color: c.textMuted, fontSize: 16, fontWeight: '600' },
  jumpLatest: { position: 'absolute', right: 12, bottom: 18, minWidth: 44, height: 40, borderRadius: 20, paddingHorizontal: 14, backgroundColor: '#24394B', borderWidth: 1, borderColor: '#55B7F3', alignItems: 'center', justifyContent: 'center', elevation: 5, flexDirection: 'row', gap: 6 },
  jumpCountText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  jumpMention: { position: 'absolute', right: 12, bottom: 18, width: 44, height: 44, borderRadius: 22, backgroundColor: '#24394B', borderWidth: 1, borderColor: '#55B7F3', alignItems: 'center', justifyContent: 'center', elevation: 5 },
  jumpMentionStacked: { bottom: 68 },
  jumpMentionText: { color: '#55B7F3', fontSize: 20, fontWeight: '900', marginTop: -2 },
  jumpMentionBadge: { position: 'absolute', top: -6, right: -4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#2589F5', alignItems: 'center', justifyContent: 'center' },
  jumpMentionBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  jumpArrow: { color: '#55B7F3', fontSize: 16, fontWeight: '900' },
  pinnedBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
  pinnedAccent: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c.accent },
  pinnedCopy: { flex: 1, minWidth: 0 },
  pinnedLabel: { color: c.accent, fontSize: 12, fontWeight: '800' },
  pinnedText: { color: c.text, fontSize: 13, marginTop: 1 },
  pinnedThumb: { width: 34, height: 34, borderRadius: 6, backgroundColor: c.surfaceRaised },
  pinnedListIcon: { color: c.textMuted, fontSize: 20, fontWeight: '700', paddingHorizontal: 4 },
  pinIndicator: { width: 3, alignSelf: 'stretch', gap: 2 },
  pinSegment: { flex: 1, borderRadius: 2, backgroundColor: c.border },
  pinSegmentActive: { backgroundColor: c.accent },
  bubbleHighlight: { borderWidth: 2, borderColor: c.accent },
  bubbleMention: { borderLeftWidth: 3, borderLeftColor: '#2589F5', backgroundColor: '#22384F' },
  pinsScreen: { flex: 1, backgroundColor: c.background },
  pinsHeader: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  pinsBack: { color: c.cream, fontSize: 36, width: 24 },
  pinsTitle: { flex: 1, color: c.text, fontSize: 17, fontWeight: '800' },
  pinsUnpinAll: { color: c.danger, fontWeight: '800', fontSize: 13 },
  pinsList: { padding: 14, gap: 10, paddingBottom: 24 },
  pinItem: { padding: 12, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 4 },
  pinItemPressed: { opacity: 0.85 },
  pinItemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  pinItemUnpin: { alignSelf: 'flex-end', paddingTop: 4 },
  pinsHide: { margin: 14, height: 48, borderRadius: 24, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  pinsHideText: { color: c.cream, fontWeight: '800' },
  pinnedClose: { color: c.textMuted, fontSize: 22, fontWeight: '700', paddingHorizontal: 4 },
  unreadDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 10 },
  unreadLine: { flex: 1, height: 1, backgroundColor: 'rgba(85,183,243,0.45)' },
  unreadText: { color: '#55B7F3', fontSize: 11.5, fontWeight: '800' },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 2 },
  reactionChip: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.22)', borderWidth: 1, borderColor: 'transparent' },
  reactionChipMine: { backgroundColor: 'rgba(37,137,245,0.28)', borderColor: '#2589F5' },
  reactionChipText: { color: c.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  reactionChipTextMine: { color: '#FFFFFF' },
  webParityReactionSection: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12, gap: 10 },
  webParityReactionLabel: { color: kivoTheme.colors.textMuted, fontSize: 13 },
  webParityReactionRow: { flexDirection: 'row', gap: 8, paddingRight: 4 },
  reactionPicker: { flexDirection: 'row', gap: 4, paddingVertical: 12 },
  reactionOption: { flex: 1, aspectRatio: 1, maxWidth: 52, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  reactionOptionMine: { backgroundColor: 'rgba(37,137,245,0.28)', borderWidth: 1, borderColor: '#2589F5' },
  reactionOptionText: { fontSize: 22 },
  emptyText: { color: c.textMuted, textAlign: 'center', marginTop: 40 },
  day: { alignItems: 'center', marginVertical: 10 },
  dayText: { color: c.textMuted, fontSize: 11.5, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  bubbleRow: { flexDirection: 'row', marginVertical: 1 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowGroupIncoming: { alignItems: 'flex-end' },
  avatarColumn: { width: 34, flexShrink: 0, marginRight: 8, alignItems: 'center', justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', paddingHorizontal: 9, paddingTop: 5, paddingBottom: 4, borderRadius: 16, borderBottomLeftRadius: 4, backgroundColor: c.surfaceRaised, gap: 2 },
  bubbleMine: { backgroundColor: '#1D6B4C', borderBottomLeftRadius: 16, borderBottomRightRadius: 4 },
  post: { maxWidth: '86%', borderRadius: 14 },
  postText: { fontSize: 14, lineHeight: 19 },
  deleted: { opacity: 0.6 },
  senderLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  senderVerifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 9, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 14, height: 14, borderRadius: 7, overflow: 'hidden' },
  sender: { color: c.accent, fontSize: 12.5, fontWeight: '800' },
  forwardedLabel: { color: c.textMuted, fontSize: 11, fontStyle: 'italic', fontWeight: '700' },
  forwardOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center', padding: 22 },
  forwardSheet: { maxHeight: '78%', borderRadius: 20, overflow: 'hidden', backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  forwardHeader: { paddingHorizontal: 18, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: c.border },
  forwardTitle: { color: c.text, fontSize: 17, fontWeight: '900' },
  forwardCancel: { color: c.accent, fontSize: 13, fontWeight: '800' },
  forwardList: { flexGrow: 0 },
  forwardDestination: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  forwardDestinationCopy: { flex: 1, minWidth: 0 },
  forwardDestinationTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  forwardVerifiedBadge: { color: '#FFFFFF', backgroundColor: '#2589F5', fontSize: 9, fontWeight: '900', textAlign: 'center', textAlignVertical: 'center', width: 14, height: 14, borderRadius: 7, overflow: 'hidden' },
  forwardDestinationTitle: { color: c.text, fontSize: 14, fontWeight: '800' },
  forwardDestinationKind: { color: c.textMuted, fontSize: 11.5, marginTop: 3 },
  photo: { width: 240, maxWidth: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: c.background },
  photoUnavailable: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  photoUnavailableText: { color: c.textMuted, fontSize: 12, fontWeight: '700' },
  text: { color: c.text, fontSize: 15, lineHeight: 20 },
  showMore: { color: c.accent, fontWeight: '800', fontSize: 13, marginTop: 4 },
  limitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 6 },
  limitCount: { color: c.textMuted, fontSize: 12 },
  limitOver: { color: c.danger },
  limitHint: { color: '#2589F5', fontSize: 12, fontWeight: '800', flexShrink: 1, textAlign: 'right' },
  messageLink: { color: c.accent, backgroundColor: 'rgba(244,240,199,0.10)', borderRadius: 3 },
  messageHashtag: { color: '#9BC9FF', backgroundColor: 'rgba(115,170,255,0.12)' },
  messageTicker: { color: c.accent, fontWeight: '800', backgroundColor: 'rgba(183,226,123,0.12)' },
  messageMention: { color: '#9BC9FF', fontWeight: '800' },
  messageMentionMe: { color: '#FFFFFF', fontWeight: '900', backgroundColor: 'rgba(37,137,245,0.45)', borderRadius: 3 },
  deletedText: { color: c.textMuted, fontStyle: 'italic', fontSize: 13 },
  meta: { color: 'rgba(247,245,223,0.6)', fontSize: 10.5, alignSelf: 'flex-end' },
  metaInline: { position: 'absolute', right: 9, bottom: 4 },
  metaSpacer: { color: 'transparent', fontSize: 10.5 },
  mentionList: { maxHeight: 220, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  mentionRowPressed: { backgroundColor: c.surfaceRaised },
  mentionName: { flex: 1, color: c.text, fontWeight: '700', fontSize: 14 },
  composerArea: { position: 'relative' },
  modalShade: {flex:1,backgroundColor:'rgba(0,0,0,0.6)',justifyContent:'flex-end'}, pollSheet:{maxHeight:'92%',backgroundColor:kivoTheme.colors.background,borderTopLeftRadius:22,borderTopRightRadius:22,padding:18,paddingBottom:30,gap:12,borderWidth:1,borderColor:kivoTheme.colors.border}, pollInput:{color:kivoTheme.colors.text,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:10,padding:10,marginVertical:5},pollSettingRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:9},pollLabel:{color:kivoTheme.colors.text,fontSize:14},pollDuration:{padding:8,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:9},pollDurationOn:{borderColor:kivoTheme.colors.accent},pollActions:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingTop:10},pollSend:{backgroundColor:kivoTheme.colors.accent,paddingHorizontal:16,paddingVertical:10,borderRadius:12},pollSendText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'900'},
  attachmentMenu: { position: 'absolute', zIndex: 20, left: 10, bottom: 62, width: 250, maxWidth: '90%', flexDirection: 'row', gap: 5, padding: 6, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, elevation: 8 },
  attachmentTile: { flex: 1, minWidth: 0, minHeight: 48, paddingVertical: 5, paddingHorizontal: 2, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  attachmentTilePressed: { backgroundColor: c.background },
  attachmentTileDisabled: { opacity: 0.58 },
  attachmentLabel: { color: c.text, fontSize: 10.5, lineHeight: 12, fontWeight: '700', textAlign: 'center' },
  attachmentHint: { color: c.textMuted, fontSize: 9, lineHeight: 10 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 5, paddingHorizontal: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background },
  attach: { width: 28, height: 40, alignItems: 'center', justifyContent: 'center' },
  attachText: { color: c.cream, fontSize: 23 },
  input: { flex: 1, minWidth: 0, minHeight: 40, maxHeight: 140, borderRadius: 22, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, backgroundColor: c.surface, color: c.text, fontSize: 15 },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: c.backgroundDeep, fontSize: 16, fontWeight: '900' },
  readonly: { padding: 14, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background, alignItems: 'center' },
  readonlyText: { color: c.textMuted, fontSize: 13 },
});
