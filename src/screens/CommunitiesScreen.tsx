import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { launchImageLibrary, type ImagePickerAsset } from 'react-native-image-picker';
import type { ApiCommunity, CommunityKind } from '@kivo/shared/api/types';
import { API_LIMITS } from '@kivo/shared/api/types';
import { refreshConversations } from '@kivo/shared/chat/store';
import { kivoTheme } from '../theme/kivoTheme';
import { api, useSocialReady } from '../state/session';
import { Avatar, EnableSocial } from './ChatListScreen';

/** Groups and channels: yours, public ones to discover, and create — all on the Kivo social API. */
export function CommunitiesScreen({ kind: initialKind = 'group', onOpenChat, onOpenInfo, onBack }: {
  kind?: CommunityKind;
  onOpenChat: (id: string) => void;
  onOpenInfo: (id: string) => void;
  onBack?: () => void;
}) {
  const ready = useSocialReady();
  const [kind, setKind] = useState<CommunityKind>(initialKind);
  const [mine, setMine] = useState<ApiCommunity[] | null>(null);
  const [discover, setDiscover] = useState<ApiCommunity[] | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [own, found] = await Promise.all([ready ? api.myCommunities() : Promise.resolve([]), api.discover(kind, query.trim())]);
      setMine(own.filter(c => c.kind === kind));
      setDiscover(found.filter(c => !c.myRole));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load communities.'); setMine([]); setDiscover([]); }
  }, [kind, query, ready]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const join = async (c: ApiCommunity) => {
    if (!ready) { Alert.alert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    try { await api.join(c.id); await refreshConversations().catch(() => {}); onOpenChat(c.id); }
    catch (e) { Alert.alert(c.name, e instanceof Error ? e.message : 'Unable to join.'); }
  };

  if (!ready && creating) return <EnableSocial />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={kivoTheme.colors.accent} />}>
      <View style={styles.header}>
        {onBack && <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>}
        <Text style={styles.title}>Communities</Text>
        <Pressable onPress={() => setCreating(v => !v)} style={styles.create}><Text style={styles.createText}>{creating ? 'Close' : `＋ New ${kind}`}</Text></Pressable>
      </View>
      <View style={styles.switcher}>
        {(['group', 'channel'] as CommunityKind[]).map(k => (
          <Pressable key={k} onPress={() => setKind(k)} style={[styles.tab, kind === k && styles.tabActive]}><Text style={[styles.tabText, kind === k && styles.tabTextActive]}>{k === 'group' ? 'Groups' : 'Channels'}</Text></Pressable>
        ))}
      </View>
      {creating && <CreateForm kind={kind} onCreated={c => { setCreating(false); onOpenChat(c.id); }} />}
      {ready && <>
        <Text style={styles.section}>Yours</Text>
        {mine == null ? <ActivityIndicator color={kivoTheme.colors.accent} /> : mine.length === 0 ? <Text style={styles.muted}>You have not joined any {kind}s yet.</Text> : mine.map(c => <Row key={c.id} community={c} onPress={() => onOpenChat(c.id)} onInfo={() => onOpenInfo(c.id)} />)}
      </>}
      <Text style={styles.section}>Discover</Text>
      <TextInput value={query} onChangeText={setQuery} placeholder={`Search public ${kind}s`} placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {discover == null ? <ActivityIndicator color={kivoTheme.colors.accent} /> : discover.length === 0 ? <Text style={styles.muted}>No public {kind}s found.</Text> : discover.map(c => (
        <Row key={c.id} community={c} onPress={() => onOpenInfo(c.id)} action={<Pressable onPress={() => join(c)} style={styles.join}><Text style={styles.joinText}>{c.kind === 'channel' ? 'Subscribe' : 'Join'}</Text></Pressable>} />
      ))}
      <View style={styles.rules}>
        <Text style={styles.rulesTitle}>How ownership works</Text>
        <Text style={styles.muted}>The creator owns it. Only the owner promotes or demotes admins. Admins manage regular members — never the owner or other admins — and never become owners.</Text>
      </View>
    </ScrollView>
  );
}

function Row({ community: c, onPress, onInfo, action }: { community: ApiCommunity; onPress: () => void; onInfo?: () => void; action?: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Avatar name={c.name} uri={c.avatarUrl} size={46} />
      <View style={styles.flex}>
        <View style={styles.rowTitleLine}><Text style={styles.rowTitle} numberOfLines={1}>{c.name}</Text>{c.kind === 'channel' && (c.isVerified || c.id === 'ch_671d27c151fefc25c8e5') ? <Text accessibilityLabel="Verified official Kivo channel" style={styles.verifiedBadge}>★</Text> : null}</View>
        <Text style={styles.small} numberOfLines={1}>{c.memberCount} {c.kind === 'channel' ? 'subscribers' : 'members'}{c.myRole ? ` · ${c.myRole === 'owner' ? 'Owner' : c.myRole === 'admin' ? 'Admin' : c.kind === 'channel' ? 'Subscribed' : 'Member'}` : ''}</Text>
      </View>
      {action ?? (onInfo ? <Pressable onPress={onInfo} hitSlop={8}><Text style={styles.infoIcon}>ⓘ</Text></Pressable> : null)}
    </Pressable>
  );
}

function CreateForm({ kind, onCreated }: { kind: CommunityKind; onCreated: (c: ApiCommunity) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [photo, setPhoto] = useState<ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const pickPhoto = async () => {
    try {
      // Keep the mobile image pipeline lightweight: resize before upload and
      // let the native picker re-encode to JPEG at moderate quality.
      const result = await launchImageLibrary({
        mediaType: 'photo', selectionLimit: 1, maxWidth: API_LIMITS.avatarEdge,
        maxHeight: API_LIMITS.avatarEdge, quality: 0.65, assetRepresentationMode: 'compatible',
      });
      if (result.didCancel) return;
      if (result.errorCode) throw new Error(result.errorMessage || 'Could not open your photos.');
      const asset = result.assets?.[0];
      if (!asset?.uri) throw new Error('No readable photo was selected. Please try another image.');
      if (asset.type && !['image/jpeg', 'image/png', 'image/webp'].includes(asset.type)) {
        throw new Error('Choose a JPG, PNG or WebP photo.');
      }
      if (asset.fileSize && asset.fileSize > API_LIMITS.maxAvatarBytes) {
        throw new Error('This photo is still too large after compression. Choose another photo.');
      }
      setPhoto(asset);
    } catch (e) {
      Alert.alert('Photo', e instanceof Error ? e.message : 'Could not read this photo. Please try another image.');
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      let avatarKey: string | null = null;
      if (photo?.uri) {
        const type = photo.type && ['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) ? photo.type : 'image/jpeg';
        let bytes: Blob;
        try { bytes = await (await fetch(photo.uri)).blob(); }
        catch { throw new Error('Kivo could not read that photo. Please select it again from Gallery.'); }
        if (!bytes.size) throw new Error('The selected photo is empty or unreadable. Please choose another.');
        if (bytes.size > API_LIMITS.maxAvatarBytes) throw new Error('The compressed photo exceeds Kivo’s size limit. Please choose another photo.');
        const uploaded = await api.uploadImage(bytes, type, 'avatar');
        avatarKey = uploaded.key;
      }
      const created = await api.createCommunity({ kind, name, description, visibility, avatarKey });
      await refreshConversations().catch(() => {});
      onCreated(created);
    } catch (e) { Alert.alert('Create', e instanceof Error ? e.message : 'Unable to create.'); }
    finally { setBusy(false); }
  };
  return (
    <View style={styles.form}>
      <Text style={styles.rowTitle}>New {kind}</Text>
      <TextInput value={name} onChangeText={setName} maxLength={API_LIMITS.maxCommunityNameChars} placeholder="Name" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
      <TextInput value={description} onChangeText={setDescription} maxLength={API_LIMITS.maxCommunityDescriptionChars} multiline placeholder="What is it about? (optional)" placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.input, styles.multiline]} />
      <View style={styles.switcher}>
        {(['public', 'private'] as const).map(v => <Pressable key={v} onPress={() => setVisibility(v)} style={[styles.tab, visibility === v && styles.tabActive]}><Text style={[styles.tabText, visibility === v && styles.tabTextActive]}>{v === 'public' ? 'Public' : 'Private'}</Text></Pressable>)}
      </View>
      <View style={styles.photoRow}>
        {photo?.uri ? <Image source={{ uri: photo.uri }} style={styles.photoPreview} /> : null}
        <Pressable disabled={busy} onPress={pickPhoto} style={styles.secondary}><Text style={styles.secondaryText}>{photo ? 'Change photo' : `Add ${kind} photo`}</Text></Pressable>
        {photo ? <Pressable disabled={busy} onPress={() => setPhoto(null)}><Text style={styles.removePhoto}>Remove</Text></Pressable> : null}
      </View>
      <Text style={styles.muted}>Photos are resized and compressed on your device before upload to reduce storage and data use. You become the permanent owner. Admins you promote never receive ownership.</Text>
      <Pressable disabled={busy || name.trim().length < 2} onPress={create} style={[styles.primary, (busy || name.trim().length < 2) && styles.disabled]}><Text style={styles.primaryText}>{busy ? 'Creating…' : `Create ${kind}`}</Text></Pressable>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  body: { padding: 18, paddingBottom: 40, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  back: { color: c.cream, fontSize: 36, width: 24 },
  title: { flex: 1, color: c.text, fontSize: 28, fontWeight: '800' },
  create: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  createText: { color: c.cream, fontSize: 12, fontWeight: '800' },
  switcher: { flexDirection: 'row', padding: 4, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 999 },
  tabActive: { backgroundColor: c.cream },
  tabText: { color: c.textMuted, fontWeight: '800', fontSize: 12.5 },
  tabTextActive: { color: c.backgroundDeep },
  section: { color: c.text, fontSize: 17, fontWeight: '800', marginTop: 10 },
  muted: { color: c.textMuted, fontSize: 12.5, lineHeight: 18 },
  small: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  error: { color: c.danger, fontSize: 12.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  flex: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  rowTitle: { color: c.text, fontWeight: '800', fontSize: 15, flexShrink: 1 },
  verifiedBadge: { overflow: 'hidden', color: '#2589F5', fontSize: 20, fontWeight: '900', textAlign: 'center', width: 20, height: 22 },
  infoIcon: { color: c.textMuted, fontSize: 20 },
  join: { backgroundColor: c.cream, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  joinText: { color: c.backgroundDeep, fontWeight: '800', fontSize: 12.5 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: c.text, backgroundColor: c.backgroundDeep, fontSize: 14 },
  multiline: { minHeight: 70, textAlignVertical: 'top' },
  form: { padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 10 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  photoPreview: { width: 56, height: 56, borderRadius: 16, backgroundColor: c.surfaceRaised },
  secondary: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 },
  secondaryText: { color: c.cream, fontSize: 12.5, fontWeight: '800' },
  removePhoto: { color: c.danger, fontSize: 12.5, fontWeight: '700' },
  primary: { height: 48, borderRadius: 24, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: c.backgroundDeep, fontWeight: '900' },
  disabled: { opacity: 0.45 },
  rules: { marginTop: 14, padding: 14, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 6 },
  rulesTitle: { color: c.text, fontWeight: '800' },
});
