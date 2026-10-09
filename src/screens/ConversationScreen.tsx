import React, { useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS } from '@kivo/shared/api/types';
import { deleteForEveryone, discardMessage, displayName, myUserId, retryMessage, sendImage, sendText, type LocalMessage } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { useActiveConversation, useChatState } from '../state/useChat';
import { Avatar } from './ChatListScreen';

type Item = { type: 'day'; key: string; label: string } | { type: 'message'; key: string; message: LocalMessage; showName: boolean };

function renderLinkedText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[]=[]; const pattern= /https?:\/\/[^\\s<>"']+|www\\.[^\\s<>"']+|#[\\p{L}\\p{N}_]+|\\$[A-Za-z][A-Za-z0-9_]*/gu; let cursor=0; let key=0;
  for(const match of text.matchAll(pattern)){const raw=match[0];const start=match.index??0;if(start>cursor)nodes.push(text.slice(cursor,start));let url:string;let style=styles.messageLink;
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

export function ConversationScreen({ id, onBack, onOpenInfo, onOpenPerson }: { id: string; onBack?: () => void; onOpenInfo?: (id: string, kind: 'group' | 'channel') => void; onOpenPerson?: (userId: string) => void }) {
  useActiveConversation(id);
  const state = useChatState();
  const conversation = state.conversations.find(c => c.id === id);
  const messages = state.messages[id] ?? [];
  const [draft, setDraft] = useState('');
  const list = useRef<FlatList<Item>>(null);
  const me = myUserId();
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
      out.push({ type: 'message', key: message.id, message, showName: conversation?.kind !== 'dm' && message.senderId !== me && messages[index - 1]?.senderId !== message.senderId });
    });
    return out;
  }, [messages, conversation?.kind, me]);

  const send = async () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    try { await sendText(id, text); } catch (error) { Alert.alert('Message', error instanceof Error ? error.message : 'Not sent.'); }
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
    if (message.status !== 'sent' || message.deleted || (message.senderId !== me && !canModerate)) return;
    Alert.alert('Delete message', 'Delete this message for everyone?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteForEveryone(id, message.id).catch(error => Alert.alert('Delete', error instanceof Error ? error.message : 'Could not delete.')) },
    ]);
  };

  const title = conversation?.title ?? 'Conversation';
  const subtitle = !state.online ? 'Offline — will sync when back' : conversation?.kind === 'dm' ? (conversation.peer ? `${conversation.peer.address.slice(0, 6)}…${conversation.peer.address.slice(-4)}` : 'Direct message') : isChannel ? 'Channel' : 'Group';

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back"><Text style={styles.back}>‹</Text></Pressable>
        <Avatar name={title} uri={conversation?.avatarUrl} size={40} />
        <Pressable style={styles.headerCopy} disabled={!conversation || conversation.kind === 'dm'} onPress={() => conversation && conversation.kind !== 'dm' && onOpenInfo?.(id, conversation.kind)}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          <Text style={styles.status}>{subtitle}</Text>
        </Pressable>
        {conversation && conversation.kind !== 'dm' && <Pressable onPress={() => onOpenInfo?.(id, conversation.kind as 'group' | 'channel')} hitSlop={10}><Text style={styles.info}>ⓘ</Text></Pressable>}
      </View>
      <FlatList
        ref={list}
        data={items}
        keyExtractor={item => item.key}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={<Text style={styles.emptyText}>{isChannel ? 'No posts yet.' : 'No messages yet. Say hello 👋'}</Text>}
        renderItem={({ item }) => {
          if (item.type === 'day') return <View style={styles.day}><Text style={styles.dayText}>{item.label}</Text></View>;
          const { message } = item;
          const mine = message.senderId === me && !isChannel;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <Pressable onLongPress={() => onLongPress(message)} style={[styles.bubble, mine && styles.bubbleMine, isChannel && styles.post, message.deleted && styles.deleted]}>
                {item.showName && <Pressable onPress={() => onOpenPerson?.(message.senderId)} disabled={!onOpenPerson} hitSlop={6}><Text style={styles.sender}>{displayName(message.senderId)}</Text></Pressable>}
                {message.media && <Image source={{ uri: message.media.url }} style={[styles.photo, message.media.width && message.media.height ? { aspectRatio: message.media.width / message.media.height } : null]} resizeMode="cover" />}
                {message.deleted ? <Text style={styles.deletedText}>Message deleted</Text> : message.text ? <Text style={styles.text}>{renderLinkedText(message.text)}</Text> : null}
                <Text style={styles.meta}>
                  {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {mine ? message.status === 'pending' ? '  ◷' : message.status === 'failed' ? '  ⚠ tap & hold' : '  ✓' : ''}
                </Text>
              </Pressable>
            </View>
          );
        }}
      />
      {canPost ? (
        <View style={styles.composer}>
          <Pressable onPress={attach} hitSlop={8} style={styles.attach} accessibilityLabel="Attach photo"><Text style={styles.attachText}>＋</Text></Pressable>
          <TextInput value={draft} onChangeText={setDraft} placeholder="Message" placeholderTextColor={kivoTheme.colors.textMuted} multiline maxLength={API_LIMITS.maxMessageChars} style={styles.input} />
          <Pressable disabled={!draft.trim()} onPress={send} style={[styles.send, !draft.trim() && styles.sendDisabled]} accessibilityLabel="Send"><Text style={styles.sendText}>➤</Text></Pressable>
        </View>
      ) : (
        <View style={styles.readonly}><Text style={styles.readonlyText}>📢 Only the channel owner and admins can post.</Text></View>
      )}
    </KeyboardAvoidingView>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.backgroundDeep },
  header: { minHeight: 64, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.background },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerCopy: { flex: 1, minWidth: 0 },
  name: { color: c.text, fontSize: 16, fontWeight: '800' },
  status: { color: c.textMuted, fontSize: 11.5, marginTop: 2 },
  info: { color: c.cream, fontSize: 20, paddingHorizontal: 6 },
  messages: { padding: 10, paddingBottom: 16, gap: 3 },
  emptyText: { color: c.textMuted, textAlign: 'center', marginTop: 40 },
  day: { alignItems: 'center', marginVertical: 10 },
  dayText: { color: c.textMuted, fontSize: 11.5, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  bubbleRow: { flexDirection: 'row', marginVertical: 1 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', paddingHorizontal: 11, paddingTop: 7, paddingBottom: 5, borderRadius: 16, borderBottomLeftRadius: 4, backgroundColor: c.surfaceRaised, gap: 4 },
  bubbleMine: { backgroundColor: '#1D6B4C', borderBottomLeftRadius: 16, borderBottomRightRadius: 4 },
  post: { maxWidth: '96%', borderRadius: 16 },
  deleted: { opacity: 0.6 },
  sender: { color: c.accent, fontSize: 12.5, fontWeight: '800' },
  photo: { width: 240, maxWidth: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: c.background },
  text: { color: c.text, fontSize: 15, lineHeight: 20 },
  messageLink: { color: c.accent, textDecorationLine: 'underline', backgroundColor: 'rgba(244,240,199,0.10)', borderRadius: 3, overflow: 'hidden' },
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
