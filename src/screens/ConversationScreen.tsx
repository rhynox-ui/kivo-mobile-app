import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS, messageCharLimit, messageLength, shortWallet } from '@kivo/shared/api/types';
import { deleteForEveryone, discardMessage, displayName, editMessage, forwardMessage, myUserId, retryMessage, sendImage, sendText, type LocalMessage } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { useActiveConversation, useChatState } from '../state/useChat';
import { Avatar } from './ChatListScreen';
import { api } from '../state/session';
import { KivoModal } from '../components/KivoModal';
import { BottomSheet } from '../components/BottomSheet';
import { PhotoViewer } from '../components/PhotoViewer';

type Item = { type: 'day'; key: string; label: string } | { type: 'message'; key: string; message: LocalMessage; showName: boolean; showAvatar: boolean };

function renderLinkedText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[]=[]; const pattern= /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|#[\p{L}\p{N}_]+|\$[A-Za-z][A-Za-z0-9_]*/gu; let cursor=0; let key=0;
  for(const match of text.matchAll(pattern)){const raw=match[0];const start=match.index??0;if(start>cursor)nodes.push(text.slice(cursor,start));let url:string;let style:TextStyle=styles.messageLink;
    if(raw.startsWith('#')){url='https://x.com/hashtag/'+encodeURIComponent(raw.slice(1));style=styles.messageHashtag;}
    else if(raw.startsWith('$')){url='https://dexscreener.com/search?q='+encodeURIComponent(raw.slice(1));style=styles.messageTicker;}
    else{const clean=raw.replace(/[),.!?;:]+$/,'');url=clean.startsWith('www.')?'https://'+clean:clean;nodes.push(<Text key={`link-${key++}`} accessibilityRole="link" onPress={()=>Linking.openURL(url).catch(()=>kivoAlert('Link','Could not open this link.'))} style={style}>{clean}</Text>);const tail=raw.slice(clean.length);if(tail)nodes.push(tail);cursor=start+raw.length;continue;}
    nodes.push(<Text key={`link-${key++}`} accessibilityRole="link" onPress={()=>Linking.openURL(url).catch(()=>kivoAlert('Link','Could not open this link.'))} style={style}>{raw}</Text>);cursor=start+raw.length;
  } if(cursor<text.length)nodes.push(text.slice(cursor));return nodes.length?nodes:[text];
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

export function ConversationScreen({ id, onBack, onOpenInfo, onOpenPerson }: { id: string; onBack?: () => void; onOpenInfo?: (id: string, kind: 'group' | 'channel') => void; onOpenPerson?: (userId: string) => void }) {
  useActiveConversation(id);
  const state = useChatState();
  const conversation = state.conversations.find(c => c.id === id);
  const messages = state.messages[id] ?? [];
  const [draft, setDraft] = useState('');
  const [tokenAttachmentOpen, setTokenAttachmentOpen] = useState(false);
  const [tokenAttachmentChain, setTokenAttachmentChain] = useState('solana');
  const [tokenAttachmentAddress, setTokenAttachmentAddress] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  type MenuItem = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };
  const [optionsMenu, setOptionsMenu] = useState<MenuItem[] | null>(null);
  const [replyingTo, setReplyingTo] = useState<LocalMessage | null>(null);
  const [viewing, setViewing] = useState<LocalMessage | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<LocalMessage | null>(null);
  const list = useRef<FlatList<Item>>(null);
  const atBottom = useRef(true);
  const previousMessageCount = useRef(messages.length);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const me = myUserId();
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
      out.push({ type: 'message', key: message.id, message, showName: conversation?.kind !== 'dm' && message.senderId !== me && messages[index - 1]?.senderId !== message.senderId, showAvatar: conversation?.kind === 'group' && message.senderId !== me && messages[index + 1]?.senderId !== message.senderId });
    });
    return out;
  }, [messages, conversation?.kind, me]);

  const send = async () => {
    if (sendingRef.current) return;
    const text = draft;
    if (!text.trim() && !tokenAttachmentAddress.trim()) return;
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
        await sendText(id, text, replyingTo?.id, tokenAttachmentAddress.trim() ? {chain: tokenAttachmentChain, address: tokenAttachmentAddress.trim()} : undefined);
        setDraft('');
        setReplyingTo(null);
        setTokenAttachmentAddress('');
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
    // Same options as the web app, in a Kivo-styled sheet instead of the system dialog.
    setOptionsMenu([
      ...(canPost ? [{ text: 'Reply', onPress: () => { setEditingMessageId(null); setReplyingTo(message); } }] : []),
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
    <KeyboardAvoidingView style={styles.root} behavior="padding">
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
      <View style={styles.listWrap}>
      <FlatList
        ref={list}
        data={items}
        keyExtractor={item => item.key}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => {
          const added = Math.max(0, messages.length - previousMessageCount.current);
          previousMessageCount.current = messages.length;
          if (atBottom.current) {
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
        ListEmptyComponent={<Text style={styles.emptyText}>{isChannel ? 'No posts yet.' : 'No messages yet. Say hello 👋'}</Text>}
        renderItem={({ item }) => {
          if (item.type === 'day') return <View style={styles.day}><Text style={styles.dayText}>{item.label}</Text></View>;
          const { message } = item;
          const mine = message.senderId === me && !isChannel;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine, conversation?.kind === 'group' && !mine && styles.bubbleRowGroupIncoming]}>
              {conversation?.kind === 'group' && !mine ? <View style={styles.avatarColumn}>{item.showAvatar ? <Avatar name={displayName(message.senderId)} uri={state.profiles[message.senderId]?.avatarUrl} size={30} verified={verifiedSenders.has(message.senderId)} /> : null}</View> : null}
              <Pressable onLongPress={() => onLongPress(message)} style={[styles.bubble, mine && styles.bubbleMine, isChannel && styles.post, message.deleted && styles.deleted]}>
                {message.forwardedFrom ? <Text style={styles.forwardedLabel}>↪ Forwarded from {displayName(message.forwardedFrom)}</Text> : null}
                {item.showName && <Pressable onPress={() => onOpenPerson?.(message.senderId)} disabled={!onOpenPerson} hitSlop={6}><View style={styles.senderLine}><Text style={styles.sender}>{displayName(message.senderId)}</Text>{verifiedSenders.has(message.senderId) ? <Text accessibilityLabel="Blue Star verified profile" style={styles.senderVerifiedBadge}>★</Text> : null}</View></Pressable>}
                {message.token && <View style={styles.tokenAttachment}><Text style={styles.tokenAttachmentSymbol}>{message.token.symbol ? ' uri={message.media.url} width={message.media.width} height={message.media.height} onOpen={() => setViewing(message)} onLongPress={() => onLongPress(message)} />}
                {message.replyTo && !message.deleted ? (() => {
                  const quoted = messages.find(item => item.id === message.replyTo);
                  return <View style={styles.replyQuote}><Text style={styles.replyQuoteName} numberOfLines={1}>{quoted ? displayName(quoted.senderId) : 'Reply'}</Text><Text style={styles.replyQuoteText} numberOfLines={2}>{quoted ? (quoted.deleted ? 'Message deleted' : quoted.text || '📷 Photo') : 'Original message is not available'}</Text></View>;
                })() : null}
                {message.deleted ? <Text style={styles.deletedText}>Message deleted</Text> : message.text ? (() => {
                  // Long messages collapse after ~12 lines so one post can't take over the chat.
                  const long = messageLength(message.text) > 700 || message.text.split('\n').length > 12;
                  const open = expanded[message.id] === true;
                  return <View>
                    <Text style={styles.text} numberOfLines={long && !open ? 12 : undefined}>{renderLinkedText(message.text)}</Text>
                    {long ? <Pressable hitSlop={6} onPress={() => setExpanded(prev => ({ ...prev, [message.id]: !open }))}><Text style={styles.showMore}>{open ? 'Show less' : 'Show more'}</Text></Pressable> : null}
                  </View>;
                })() : null}
                <Text style={styles.meta}>
                  {message.editedAt ? 'edited · ' : ''}{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {mine ? message.status === 'pending' ? '  ◷' : message.status === 'failed' ? '  ⚠ tap & hold' : '  ✓' : ''}
                </Text>
              </Pressable>
            </View>
          );
        }}
      />

        {unseenMessages > 0 && (
          <Pressable style={styles.jumpLatest} onPress={() => { list.current?.scrollToEnd({ animated: true }); atBottom.current = true; setUnseenMessages(0); }} accessibilityLabel="Jump to latest messages">
            <View style={styles.jumpCount}><Text style={styles.jumpCountText}>{unseenMessages > 999 ? '999+' : unseenMessages}</Text></View>
            <Text style={styles.jumpArrow}>⌄</Text>
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
        {tokenAttachmentOpen && <View style={styles.tokenAttachPanel}><View style={styles.tokenChainRow}>{['solana','base','ethereum','bnb'].map(chain => <Pressable key={chain} style={[styles.tokenChainChoice, tokenAttachmentChain === chain && styles.tokenChainChoiceActive]} onPress={() => setTokenAttachmentChain(chain)}><Text style={styles.tokenChainChoiceText}>{chain}</Text></Pressable>)}</View><TextInput value={tokenAttachmentAddress} onChangeText={setTokenAttachmentAddress} autoCapitalize="none" placeholder="Token mint / contract address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.tokenAddressInput}/></View>}
        <View style={styles.composer}>
          <Pressable onPress={() => setTokenAttachmentOpen(value => !value)} hitSlop={8} style={styles.attach} accessibilityLabel="Attach token"><Text style={styles.attachText}>◇</Text></Pressable>
          <Pressable onPress={attach} hitSlop={8} style={styles.attach} accessibilityLabel="Attach photo"><Text style={styles.attachText}>＋</Text></Pressable>
          <TextInput value={draft} onChangeText={setDraft} placeholder={editingMessageId ? 'Edit message' : 'Message'} placeholderTextColor={kivoTheme.colors.textMuted} multiline maxLength={messageCharLimit(true) * 2} style={styles.input} />
          <Pressable disabled={!draft.trim() || sending} onPress={send} style={[styles.send, (!draft.trim() || overLimit || sending) && styles.sendDisabled]} accessibilityLabel={editingMessageId ? 'Save edit' : 'Send'}><Text style={styles.sendText}>{editingMessageId ? '✓' : '➤'}</Text></Pressable>
        </View>
        </View>
      ) : (
        <View style={styles.readonly}><Text style={styles.readonlyText}>{conversation?.kind === 'group' ? '📢 Only admins can send messages.' : '📢 Only the channel owner and admins can post.'}</Text></View>
      )}
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
      <BottomSheet visible={!!optionsMenu} onClose={() => setOptionsMenu(null)}>
        <Text style={styles.sheetTitle}>Message options</Text>
        {(optionsMenu ?? []).map(item => (
          <Pressable key={item.text} style={styles.sheetRow} accessibilityRole="button" onPress={() => { setOptionsMenu(null); item.onPress?.(); }}>
            <Text style={[styles.sheetRowText, item.style === 'destructive' && styles.sheetRowDanger]}>{item.text}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.sheetRow} accessibilityRole="button" onPress={() => setOptionsMenu(null)}><Text style={styles.sheetCancel}>Cancel</Text></Pressable>
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
  jumpLatest: { position: 'absolute', right: 12, bottom: 18, minWidth: 44, height: 44, borderRadius: 22, paddingHorizontal: 5, backgroundColor: '#24394B', alignItems: 'center', justifyContent: 'center', elevation: 5, flexDirection: 'row', gap: 3 },
  jumpCount: { minWidth: 25, height: 25, borderRadius: 13, paddingHorizontal: 5, backgroundColor: '#55B7F3', alignItems: 'center', justifyContent: 'center' },
  jumpCountText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '900', fontVariant: ['tabular-nums'] },
  jumpArrow: { color: '#EAF4FF', fontSize: 19, fontWeight: '900' },
  emptyText: { color: c.textMuted, textAlign: 'center', marginTop: 40 },
  day: { alignItems: 'center', marginVertical: 10 },
  dayText: { color: c.textMuted, fontSize: 11.5, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  bubbleRow: { flexDirection: 'row', marginVertical: 1 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowGroupIncoming: { alignItems: 'flex-end' },
  avatarColumn: { width: 34, flexShrink: 0, marginRight: 8, alignItems: 'center', justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', paddingHorizontal: 11, paddingTop: 7, paddingBottom: 5, borderRadius: 16, borderBottomLeftRadius: 4, backgroundColor: c.surfaceRaised, gap: 4 },
  bubbleMine: { backgroundColor: '#1D6B4C', borderBottomLeftRadius: 16, borderBottomRightRadius: 4 },
  post: { maxWidth: '96%', borderRadius: 16 },
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
  messageLink: { color: c.accent, textDecorationLine: 'underline', textDecorationColor: 'rgba(183,226,123,0.75)', backgroundColor: 'rgba(244,240,199,0.10)', borderRadius: 3 },
  messageHashtag: { color: '#9BC9FF', textDecorationLine: 'underline', backgroundColor: 'rgba(115,170,255,0.12)' },
  messageTicker: { color: c.accent, fontWeight: '800', backgroundColor: 'rgba(183,226,123,0.12)' },
  deletedText: { color: c.textMuted, fontStyle: 'italic', fontSize: 13 },
  meta: { color: 'rgba(247,245,223,0.6)', fontSize: 10.5, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background },
  attach: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  attachText: { color: c.cream, fontSize: 26 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, backgroundColor: c.surface, color: c.text, fontSize: 15 },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: c.backgroundDeep, fontSize: 18, fontWeight: '900' },
  readonly: { padding: 14, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background, alignItems: 'center' },
  readonlyText: { color: c.textMuted, fontSize: 13 },
});
 + message.token.symbol : 'Token attachment'}</Text><Text style={styles.tokenAttachmentName}>{message.token.name || message.token.chain}</Text><Text style={styles.tokenAttachmentAddress} numberOfLines={1}>{message.token.address}</Text><Text style={styles.tokenAttachmentHint}>Token · {message.token.chain}</Text></View>}
                {message.media && <MessagePhoto uri={message.media.url} width={message.media.width} height={message.media.height} onOpen={() => setViewing(message)} onLongPress={() => onLongPress(message)} />}
                {message.replyTo && !message.deleted ? (() => {
                  const quoted = messages.find(item => item.id === message.replyTo);
                  return <View style={styles.replyQuote}><Text style={styles.replyQuoteName} numberOfLines={1}>{quoted ? displayName(quoted.senderId) : 'Reply'}</Text><Text style={styles.replyQuoteText} numberOfLines={2}>{quoted ? (quoted.deleted ? 'Message deleted' : quoted.text || '📷 Photo') : 'Original message is not available'}</Text></View>;
                })() : null}
                {message.deleted ? <Text style={styles.deletedText}>Message deleted</Text> : message.text ? (() => {
                  // Long messages collapse after ~12 lines so one post can't take over the chat.
                  const long = messageLength(message.text) > 700 || message.text.split('\n').length > 12;
                  const open = expanded[message.id] === true;
                  return <View>
                    <Text style={styles.text} numberOfLines={long && !open ? 12 : undefined}>{renderLinkedText(message.text)}</Text>
                    {long ? <Pressable hitSlop={6} onPress={() => setExpanded(prev => ({ ...prev, [message.id]: !open }))}><Text style={styles.showMore}>{open ? 'Show less' : 'Show more'}</Text></Pressable> : null}
                  </View>;
                })() : null}
                <Text style={styles.meta}>
                  {message.editedAt ? 'edited · ' : ''}{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {mine ? message.status === 'pending' ? '  ◷' : message.status === 'failed' ? '  ⚠ tap & hold' : '  ✓' : ''}
                </Text>
              </Pressable>
            </View>
          );
        }}
      />

        {unseenMessages > 0 && (
          <Pressable style={styles.jumpLatest} onPress={() => { list.current?.scrollToEnd({ animated: true }); atBottom.current = true; setUnseenMessages(0); }} accessibilityLabel="Jump to latest messages">
            <View style={styles.jumpCount}><Text style={styles.jumpCountText}>{unseenMessages > 999 ? '999+' : unseenMessages}</Text></View>
            <Text style={styles.jumpArrow}>⌄</Text>
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
        <View style={styles.composer}>
          <Pressable onPress={attach} hitSlop={8} style={styles.attach} accessibilityLabel="Attach photo"><Text style={styles.attachText}>＋</Text></Pressable>
          <TextInput value={draft} onChangeText={setDraft} placeholder={editingMessageId ? 'Edit message' : 'Message'} placeholderTextColor={kivoTheme.colors.textMuted} multiline maxLength={messageCharLimit(true) * 2} style={styles.input} />
          <Pressable disabled={!draft.trim() || sending} onPress={send} style={[styles.send, (!draft.trim() || overLimit || sending) && styles.sendDisabled]} accessibilityLabel={editingMessageId ? 'Save edit' : 'Send'}><Text style={styles.sendText}>{editingMessageId ? '✓' : '➤'}</Text></Pressable>
        </View>
        </View>
      ) : (
        <View style={styles.readonly}><Text style={styles.readonlyText}>{conversation?.kind === 'group' ? '📢 Only admins can send messages.' : '📢 Only the channel owner and admins can post.'}</Text></View>
      )}
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
      <BottomSheet visible={!!optionsMenu} onClose={() => setOptionsMenu(null)}>
        <Text style={styles.sheetTitle}>Message options</Text>
        {(optionsMenu ?? []).map(item => (
          <Pressable key={item.text} style={styles.sheetRow} accessibilityRole="button" onPress={() => { setOptionsMenu(null); item.onPress?.(); }}>
            <Text style={[styles.sheetRowText, item.style === 'destructive' && styles.sheetRowDanger]}>{item.text}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.sheetRow} accessibilityRole="button" onPress={() => setOptionsMenu(null)}><Text style={styles.sheetCancel}>Cancel</Text></Pressable>
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
  jumpLatest: { position: 'absolute', right: 12, bottom: 18, minWidth: 44, height: 44, borderRadius: 22, paddingHorizontal: 5, backgroundColor: '#24394B', alignItems: 'center', justifyContent: 'center', elevation: 5, flexDirection: 'row', gap: 3 },
  jumpCount: { minWidth: 25, height: 25, borderRadius: 13, paddingHorizontal: 5, backgroundColor: '#55B7F3', alignItems: 'center', justifyContent: 'center' },
  jumpCountText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '900', fontVariant: ['tabular-nums'] },
  jumpArrow: { color: '#EAF4FF', fontSize: 19, fontWeight: '900' },
  emptyText: { color: c.textMuted, textAlign: 'center', marginTop: 40 },
  day: { alignItems: 'center', marginVertical: 10 },
  dayText: { color: c.textMuted, fontSize: 11.5, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  bubbleRow: { flexDirection: 'row', marginVertical: 1 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowGroupIncoming: { alignItems: 'flex-end' },
  avatarColumn: { width: 34, flexShrink: 0, marginRight: 8, alignItems: 'center', justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', paddingHorizontal: 11, paddingTop: 7, paddingBottom: 5, borderRadius: 16, borderBottomLeftRadius: 4, backgroundColor: c.surfaceRaised, gap: 4 },
  bubbleMine: { backgroundColor: '#1D6B4C', borderBottomLeftRadius: 16, borderBottomRightRadius: 4 },
  post: { maxWidth: '96%', borderRadius: 16 },
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
  messageLink: { color: c.accent, textDecorationLine: 'underline', textDecorationColor: 'rgba(183,226,123,0.75)', backgroundColor: 'rgba(244,240,199,0.10)', borderRadius: 3 },
  messageHashtag: { color: '#9BC9FF', textDecorationLine: 'underline', backgroundColor: 'rgba(115,170,255,0.12)' },
  messageTicker: { color: c.accent, fontWeight: '800', backgroundColor: 'rgba(183,226,123,0.12)' },
  deletedText: { color: c.textMuted, fontStyle: 'italic', fontSize: 13 },
  meta: { color: 'rgba(247,245,223,0.6)', fontSize: 10.5, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background },
  attach: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  attachText: { color: c.cream, fontSize: 26 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, backgroundColor: c.surface, color: c.text, fontSize: 15 },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: c.backgroundDeep, fontSize: 18, fontWeight: '900' },
  readonly: { padding: 14, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background, alignItems: 'center' },
  readonlyText: { color: c.textMuted, fontSize: 13 },
});
