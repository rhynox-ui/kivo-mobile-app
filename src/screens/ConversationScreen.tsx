import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS, isOfficialKivoChannel } from '@kivo/shared/api/types';
import { deleteForEveryone, discardMessage, displayName, editMessage, forwardMessage, myUserId, retryMessage, sendImage, sendText, type LocalMessage } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { useActiveConversation, useChatState } from '../state/useChat';
import { Avatar } from './ChatListScreen';
import { api } from '../state/session';

type Item = { type: 'day'; key: string; label: string } | { type: 'message'; key: string; message: LocalMessage; showName: boolean; showAvatar: boolean };

function renderLinkedText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[]=[]; const pattern= /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|#[\p{L}\p{N}_]+|\$[A-Za-z][A-Za-z0-9_]*/gu; let cursor=0; let key=0;
  for(const match of text.matchAll(pattern)){const raw=match[0];const start=match.index??0;if(start>cursor)nodes.push(text.slice(cursor,start));let url:string;let style:TextStyle=styles.messageLink;
    if(raw.startsWith('#')){url='https://x.com/hashtag/'+encodeURIComponent(raw.slice(1));style=styles.messageHashtag;}
    else if(raw.startsWith('$')){url='https://dexscreener.com/search?q='+encodeURIComponent(raw.slice(1));style=styles.messageTicker;}
    else{const clean=raw.replace(/[),.!?;:]+$/,'');url=clean.startsWith('www.')?'https://'+clean:clean;nodes.push(<Text key={`link-${key++}`} accessibilityRole="link" onPress={()=>Linking.openURL(url).catch(()=>Alert.alert('Link','Could not open this link.'))} style={style}>{clean}</Text>);const tail=raw.slice(clean.length);if(tail)nodes.push(tail);cursor=start+raw.length;continue;}
    nodes.push(<Text key={`link-${key++}`} accessibilityRole="link" onPress={()=>Linking.openURL(url).catch(()=>Alert.alert('Link','Could not open this link.'))} style={style}>{raw}</Text>);cursor=start+raw.length;
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

function MessagePhoto({ uri, width, height }: { uri: string; width: number | null; height: number | null }) {
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
    <Image
      source={{ uri: uri.split('?')[0], headers: api.mediaHeaders(uri.split('?')[0]) }}
      style={[styles.photo, dimensions]}
      resizeMode="cover"
      onError={() => setFailed(true)}
      accessibilityLabel="Message photo"
    />
  );
}

export function ConversationScreen({ id, onBack, onOpenInfo, onOpenPerson }: { id: string; onBack?: () => void; onOpenInfo?: (id: string, kind: 'group' | 'channel') => void; onOpenPerson?: (userId: string) => void }) {
  useActiveConversation(id);
  const state = useChatState();
  const conversation = state.conversations.find(c => c.id === id);
  const messages = state.messages[id] ?? [];
  const [draft, setDraft] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<LocalMessage | null>(null);
  const list = useRef<FlatList<Item>>(null);
  const atBottom = useRef(true);
  const previousMessageCount = useRef(messages.length);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const me = myUserId();
  const [peerVerified, setPeerVerified] = useState(false);
  const [verifiedSenders, setVerifiedSenders] = useState<Set<string>>(() => new Set());
  const senderIds = useMemo(() => Array.from(new Set(messages.filter(message => message.senderId !== me).map(message => message.senderId))), [messages, me]);
  const senderKey = senderIds.join('|');
  useEffect(() => {
    let active = true;
    const ids = senderKey ? senderKey.split('|') : [];
    Promise.all(ids.map(async userId => {
      try { return (await api.verificationStatus('profile', userId)).isVerified === true ? userId : null; }
      catch { return null; }
    })).then(results => { if (active) setVerifiedSenders(new Set(results.filter((userId): userId is string => Boolean(userId)))); });
    return () => { active = false; };
  }, [senderKey]);
  useEffect(() => {
    let active = true;
    setPeerVerified(false);
    if (conversation?.kind === 'dm' && conversation.peer?.userId) {
      api.verificationStatus('profile', conversation.peer.userId)
        .then(status => { if (active) setPeerVerified(status.isVerified === true); })
        .catch(() => { if (active) setPeerVerified(false); });
    }
    return () => { active = false; };
  }, [conversation?.kind, conversation?.peer?.userId]);
  const isChannel = conversation?.kind === 'channel';
  const canPost = !isChannel || conversation?.myRole === 'owner' || conversation?.myRole === 'admin';
  const canModerate = conversation?.myRole === 'owner' || conversation?.myRole === 'admin';

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
    const text = draft;
    if (!text.trim()) return;
    try {
      if (editingMessageId) { await editMessage(id, editingMessageId, text); setEditingMessageId(null); }
      else await sendText(id, text);
      setDraft('');
    } catch (error) { Alert.alert(editingMessageId ? 'Edit message' : 'Message', error instanceof Error ? error.message : 'Not sent.'); }
  };
  const attach = async () => {
    try {
      const photo = await pickCompressedPhoto();
      if (photo) { await sendImage(id, photo, draft); setDraft(''); }
    } catch (error) { Alert.alert('Photo', error instanceof Error ? error.message : 'Photo not sent.'); }
  };
  const onLongPress = (message: LocalMessage) => {
    if (message.status === 'failed') {
      Alert.alert('Not sent', message.error ?? 'This message was not delivered.', [
        { text: 'Discard', style: 'destructive', onPress: () => discardMessage(id, message.id) },
        ...(!message.media ? [{ text: 'Retry', onPress: () => { void retryMessage(id, message.id); } }] : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
      return;
    }
    if (message.status !== 'sent' || message.deleted) return;
    Alert.alert('Message options', undefined, [
      ...(message.senderId === me ? [{ text: 'Edit', onPress: () => { setEditingMessageId(message.id); setDraft(message.text); } }] : []),
      { text: 'Forward', onPress: () => setForwardingMessage(message) },
      ...(message.senderId === me || canModerate ? [{ text: 'Delete', style: 'destructive' as const, onPress: () => Alert.alert('Delete message', 'Delete this message for everyone?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteForEveryone(id, message.id).catch(error => Alert.alert('Delete', error instanceof Error ? error.message : 'Could not delete.')) },
      ]) }] : []),
      ...(conversation?.kind === 'dm' && message.senderId !== me && conversation.peer?.userId === message.senderId ? [{
        text: 'Block / unblock user',
        onPress: () => { void api.blockedUsers().then(blocked => {
          const isBlocked = blocked.includes(message.senderId);
          Alert.alert(isBlocked ? 'Unblock user?' : 'Block user?', isBlocked ? 'They will be able to message you again.' : 'They will no longer be able to send you direct messages. You can unblock them later.', [
            { text: 'Cancel', style: 'cancel' },
            { text: isBlocked ? 'Unblock' : 'Block', style: isBlocked ? 'default' as const : 'destructive' as const, onPress: () => (isBlocked ? api.unblockUser(message.senderId) : api.blockUser(message.senderId)).then(() => Alert.alert('Privacy', isBlocked ? 'User unblocked.' : 'User blocked.')).catch(error => Alert.alert('Privacy', error instanceof Error ? error.message : 'Action failed.')) },
          ]);
        }).catch(error => Alert.alert('Privacy', error instanceof Error ? error.message : 'Could not load block status.')); },
      }] : []),
      ...(canModerate && conversation?.kind === 'group' && message.senderId !== me ? [{
        text: 'Restrict / restore posting',
        onPress: () => { void api.community(id).then(detail => {
          const member = detail.members.find(item => item.userId === message.senderId);
          if (!member || member.role !== 'member') { Alert.alert('Moderation', 'Only regular members can be restricted.'); return; }
          const restricted = Boolean(member.restricted);
          Alert.alert(restricted ? 'Restore posting?' : 'Restrict posting?', restricted ? 'Allow this member to send messages again.' : 'This member will not be able to send messages in this group.', [
            { text: 'Cancel', style: 'cancel' },
            { text: restricted ? 'Restore' : 'Restrict', style: restricted ? 'default' as const : 'destructive' as const, onPress: () => api.setMemberRestricted(id, message.senderId, !restricted).then(() => Alert.alert('Moderation', restricted ? 'Posting restored.' : 'Member restricted.')).catch(error => Alert.alert('Moderation', error instanceof Error ? error.message : 'Action failed.')) },
          ]);
        }).catch(error => Alert.alert('Moderation', error instanceof Error ? error.message : 'Could not load member.')); },
      }] : []),
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const title = conversation?.title ?? 'Conversation';
  const subtitle = !state.online ? 'Offline — will sync when back' : conversation?.kind === 'dm' ? (conversation.peer ? `${conversation.peer.address.slice(0, 6)}…${conversation.peer.address.slice(-4)}` : 'Direct message') : isChannel ? 'Channel' : 'Group';

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back"><Text style={styles.back}>‹</Text></Pressable>
        <Pressable onPress={() => conversation?.kind === 'dm' && conversation.peer?.userId ? onOpenPerson?.(conversation.peer.userId) : conversation && conversation.kind !== 'dm' ? onOpenInfo?.(id, conversation.kind) : undefined} accessibilityLabel={conversation?.kind === 'dm' ? 'View user profile' : 'Open conversation info'}>
          <Avatar name={title} uri={conversation?.avatarUrl} size={40} verified={conversation?.kind === 'dm' ? peerVerified : conversation?.isVerified === true || (conversation?.kind === 'channel' && isOfficialKivoChannel(conversation.id))} />
        </Pressable>
        <Pressable style={styles.headerCopy} disabled={!conversation} onPress={() => conversation?.kind === 'dm' && conversation.peer?.userId ? onOpenPerson?.(conversation.peer.userId) : conversation && conversation.kind !== 'dm' ? onOpenInfo?.(id, conversation.kind) : undefined}>
          <View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{title}</Text>{conversation?.kind !== 'dm' && (conversation?.isVerified === true || (conversation?.kind === 'channel' && isOfficialKivoChannel(conversation.id))) ? <Text accessibilityLabel="Verified community" style={styles.verifiedBadge}>★</Text> : null}</View>
          <Text style={styles.status}>{subtitle}</Text>
        </Pressable>
        {conversation?.kind === 'dm' && conversation.peer?.userId && <Pressable onPress={() => {
          const peerId = conversation.peer!.userId;
          void api.blockedUsers().then(blocked => {
            const isBlocked = blocked.includes(peerId);
            Alert.alert(isBlocked ? 'Unblock user?' : 'Block user?', isBlocked ? 'They will be able to message you again.' : 'They will no longer be able to send you direct messages.', [
              { text: 'Cancel', style: 'cancel' },
              { text: isBlocked ? 'Unblock' : 'Block', style: isBlocked ? 'default' as const : 'destructive' as const, onPress: () => (isBlocked ? api.unblockUser(peerId) : api.blockUser(peerId)).then(() => Alert.alert('Privacy', isBlocked ? 'User unblocked.' : 'User blocked.')).catch(error => Alert.alert('Privacy', error instanceof Error ? error.message : 'Action failed.')) },
            ]);
          }).catch(error => Alert.alert('Privacy', error instanceof Error ? error.message : 'Could not load privacy settings.'));
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
                {message.media && <MessagePhoto uri={message.media.url} width={message.media.width} height={message.media.height} />}
                {message.deleted ? <Text style={styles.deletedText}>Message deleted</Text> : message.text ? <Text style={styles.text}>{renderLinkedText(message.text)}</Text> : null}
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
        {editingMessageId && <View style={styles.editingBar}><Text style={styles.editingLabel}>Editing message</Text><Pressable onPress={() => { setEditingMessageId(null); setDraft(''); }}><Text style={styles.editingCancel}>Cancel</Text></Pressable></View>}
        <View style={styles.composer}>
          <Pressable onPress={attach} hitSlop={8} style={styles.attach} accessibilityLabel="Attach photo"><Text style={styles.attachText}>＋</Text></Pressable>
          <TextInput value={draft} onChangeText={setDraft} placeholder={editingMessageId ? 'Edit message' : 'Message'} placeholderTextColor={kivoTheme.colors.textMuted} multiline maxLength={API_LIMITS.maxMessageChars} style={styles.input} />
          <Pressable disabled={!draft.trim()} onPress={send} style={[styles.send, !draft.trim() && styles.sendDisabled]} accessibilityLabel={editingMessageId ? 'Save edit' : 'Send'}><Text style={styles.sendText}>{editingMessageId ? '✓' : '➤'}</Text></Pressable>
        </View>
        </View>
      ) : (
        <View style={styles.readonly}><Text style={styles.readonlyText}>📢 Only the channel owner and admins can post.</Text></View>
      )}
      <Modal transparent visible={!!forwardingMessage} animationType="fade" onRequestClose={() => setForwardingMessage(null)}>
        <View style={styles.forwardOverlay}>
          <View style={styles.forwardSheet}>
            <View style={styles.forwardHeader}>
              <Text style={styles.forwardTitle}>Forward to…</Text>
              <Pressable onPress={() => setForwardingMessage(null)} hitSlop={10}><Text style={styles.forwardCancel}>Cancel</Text></Pressable>
            </View>
            <ScrollView style={styles.forwardList} keyboardShouldPersistTaps="handled">
              {state.conversations.filter(c => c.id !== id && (c.kind === 'dm' || c.myRole === 'owner' || c.myRole === 'admin' || c.kind === 'group')).map(c => (
                <Pressable key={c.id} style={styles.forwardDestination} onPress={() => {
                  const selected = forwardingMessage;
                  setForwardingMessage(null);
                  if (selected) void forwardMessage(id, selected.id, c.id).then(() => Alert.alert('Forwarded', 'Message sent to ' + c.title + '.')).catch(error => Alert.alert('Forward', error instanceof Error ? error.message : 'Could not forward.'));
                }}>
                  <Avatar name={c.title} uri={c.avatarUrl} size={38} verified={c.kind !== 'dm' && (c.isVerified === true || (c.kind === 'channel' && isOfficialKivoChannel(c.id)))} />
                  <View style={styles.forwardDestinationCopy}>
                    <View style={styles.forwardDestinationTitleLine}><Text style={styles.forwardDestinationTitle} numberOfLines={1}>{c.title}</Text>{c.kind !== 'dm' && (c.isVerified === true || (c.kind === 'channel' && isOfficialKivoChannel(c.id))) ? <Text accessibilityLabel="Verified community" style={styles.forwardVerifiedBadge}>★</Text> : null}</View>
                    <Text style={styles.forwardDestinationKind}>{c.kind === 'dm' ? 'Direct message' : c.kind === 'group' ? 'Group' : 'Channel'}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
