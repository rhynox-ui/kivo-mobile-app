import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS, normalizeProfileLinks, shortWallet, type ProfileLinks } from '@kivo/shared/api/types';
import { validBio, validProfileUsername } from '../domain/socialValidation';
import { getProfile, updateProfile } from '../state/profileStore';
import { api, enableSocial, notePublishedUsername, socialReady } from '../state/session';
import { signKivoMessage } from '../state/signGuard';
import { getWalletSession } from '../state/walletStore';
import { KivoMark } from '../components/KivoMark';
import { LinkFields, linkDraftFrom, type LinkDraft } from '../components/ProfileLinks';
import { kivoTheme } from '../theme/kivoTheme';

export function EditProfileScreen({ onBack, onOpenVerification }: { onBack: () => void; onOpenVerification?: (subjectId: string, subjectName: string) => void }) {
  const current = getProfile();
  const [name, setName] = useState(current.username);
  const [bio, setBio] = useState(current.bio);
  const [avatarUri, setAvatarUri] = useState<string | undefined>(current.avatarUri);
  // The picked photo's bytes, read the moment it is chosen (see pickAvatar).
  const [avatarFile, setAvatarFile] = useState<{ bytes: Blob; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const username = name.replace(/^@/, '').toLowerCase();
  const valid = validProfileUsername(username) && validBio(bio);
  const wallet = getWalletSession();
  const savingRef = useRef(false);
  // Blue Star links: editable only while the server says this profile is verified
  // (and chats are on, since links are saved with the signed profile update).
  const [linksState, setLinksState] = useState<'checking' | 'editable' | 'needsSocial' | 'locked' | 'unavailable'>('checking');
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(() => linkDraftFrom(null));
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.verificationStatus('profile', current.userId).then(status => status.isVerified === true),
      api.profileLinks(current.userId).catch(() => null),
    ]).then(([verified, saved]) => {
      if (!active) return;
      if (saved?.links) setLinkDraft(linkDraftFrom(saved.links));
      setLinksState(verified ? (socialReady() ? 'editable' : 'needsSocial') : 'locked');
    }).catch(() => { if (active) setLinksState('unavailable'); });
    return () => { active = false; };
  }, [current.userId]);
  const linksEditable = linksState === 'editable';

  const pickAvatar = async () => {
    // Square-ish 256px JPEG straight from the picker keeps avatars under the 48 KB cap.
    const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, maxWidth: API_LIMITS.avatarEdge, maxHeight: API_LIMITS.avatarEdge, quality: 0.7 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    // Read the bytes NOW. Saving asks for the wallet signature (biometric /
    // passcode) first; the picker's temporary file can be gone by then, which
    // made the upload fail with an unreadable photo.
    let bytes: Blob;
    try {
      bytes = await (await fetch(asset.uri)).blob();
    } catch {
      kivoAlert('Avatar', 'Kivo could not read this photo. Choose a JPG or PNG image.');
      return;
    }
    if (!bytes.size) { kivoAlert('Avatar', 'This photo is empty. Choose another one.'); return; }
    if (bytes.size > API_LIMITS.maxAvatarBytes) { kivoAlert('Avatar', 'That photo is too large even after compression. Try another one.'); return; }
    setAvatarUri(asset.uri);
    setAvatarFile({ bytes, type: asset.type === 'image/png' ? 'image/png' : 'image/jpeg' });
  };

  const save = async () => {
    // Synchronous guard: a double tap must never ask for two approvals or save twice.
    if (savingRef.current) return;
    let links: ProfileLinks | undefined;
    if (linksEditable) {
      try { links = normalizeProfileLinks(linkDraft); }
      catch (error) { kivoAlert('Links', error instanceof Error ? error.message : 'Check your links.'); return; }
    }
    savingRef.current = true;
    setBusy(true);
    try {
      let finalAvatar = avatarUri;
      // A username only helps once others can see it: sign in to Kivo first
      // (a signed message on this phone), then publish with the approval below.
      if (!socialReady()) await enableSocial().catch(() => { /* offline: saved on this phone; Profile offers to publish later */ });
      if (socialReady()) {
        const avatarAction: 'keep' | 'remove' | 'upload' = avatarFile ? 'upload' : avatarUri ? 'keep' : 'remove';
        // Links are part of the signed approval text, exactly as on web and the server.
        const approval = await api.requestProfileApproval({ username, bio, avatarAction, ...(links ? { links } : {}) });
        const signature = await signKivoMessage(approval.message, 'profile');
        let avatarKey: string | null | undefined;
        if (avatarFile) {
          const uploaded = await api.uploadImage(avatarFile.bytes, avatarFile.type, 'avatar');
          avatarKey = uploaded.key;
        } else if (avatarAction === 'remove') avatarKey = null;
        const saved = await api.updateProfile({
          username,
          bio,
          ...(avatarKey !== undefined ? { avatarKey } : {}),
          approvalNonce: approval.nonce,
          approvalSignature: signature,
          approvalAvatarAction: avatarAction,
          ...(links ? { links } : {}),
        });
        finalAvatar = saved.avatarUrl ?? undefined;
        notePublishedUsername(saved.username ?? null);
      }
      updateProfile({ username, bio, avatarUri: finalAvatar });
      if (!socialReady()) kivoAlert('Profile', 'Saved on this phone. Turn on chats to publish your @username to Kivo.');
      onBack();
    } catch (error) {
      kivoAlert('Profile', error instanceof Error ? error.message : 'Unable to save profile.');
    } finally { savingRef.current = false; setBusy(false); }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.title}>Edit profile</Text></View>
      <View style={styles.avatarRow}>
        <View style={styles.avatar}>{avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatarImage} /> : <KivoMark size={88} />}</View>
        <View style={styles.avatarActions}>
          <Pressable onPress={pickAvatar} style={styles.secondary}><Text style={styles.secondaryText}>Choose photo</Text></Pressable>
          {avatarUri ? <Pressable onPress={() => { setAvatarUri(undefined); setAvatarFile(null); }}><Text style={styles.remove}>Remove</Text></Pressable> : null}
        </View>
      </View>
      <Text style={styles.label}>Username</Text>
      <View style={styles.prefixed}><Text style={styles.at}>@</Text><TextInput value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} maxLength={32} style={styles.prefixedInput} /></View>
      <Text style={styles.label}>Bio</Text>
      <TextInput value={bio} onChangeText={setBio} multiline maxLength={160} placeholder="Crypto builder | Web3 | …" placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.input, styles.bio]} />
      <Text style={styles.counter}>{bio.length}/160</Text>
      {!valid && <Text style={styles.error}>Username: 3–32 lowercase letters, numbers or _. Bio up to 160 characters.</Text>}
      <View style={styles.linksHeader}><Text style={styles.linksTitle}>Links</Text><Text style={styles.linksStar}>★</Text></View>
      <LinkFields value={linkDraft} onChange={setLinkDraft} editable={linksEditable && !busy} />
      <Text style={styles.note}>{linksState === 'checking' ? 'Checking Blue Star…'
        : linksState === 'editable' ? 'Shown on your profile while your Blue Star is active.'
        : linksState === 'needsSocial' ? 'Turn on chats to save links.'
        : linksState === 'unavailable' ? 'Links are unavailable right now.'
        : 'Add your website, X and Telegram with Blue Star.'}</Text>
      {linksState === 'locked' && onOpenVerification ? <Pressable onPress={() => onOpenVerification(current.userId, `@${current.username}`)} style={[styles.secondary, styles.verifyButton]}><Text style={styles.secondaryText}>★ Get Verified</Text></Pressable> : null}
      <Text style={styles.note}>Wallet {wallet ? shortWallet(wallet.address) : ''} stays your identity. Changing your username or photo never changes which wallet owns this profile.</Text>
      <Pressable disabled={!valid || busy} onPress={save} style={[styles.button, (!valid || busy) && styles.disabled]}>{busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep} /> : <Text style={styles.buttonText}>Save profile</Text>}</Pressable>
    </ScrollView>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  body: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  back: { color: c.cream, fontSize: 38, width: 35 },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 8 },
  avatar: { width: 92, height: 92, borderRadius: 28, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  avatarActions: { gap: 10 },
  secondary: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  secondaryText: { color: c.cream, fontWeight: '800' },
  remove: { color: c.danger, fontWeight: '700' },
  label: { color: c.textMuted, fontSize: 12, marginTop: 14, marginBottom: 7 },
  prefixed: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 15 },
  at: { color: c.accent, fontSize: 17, fontWeight: '800', marginLeft: 14 },
  prefixedInput: { flex: 1, color: c.text, padding: 14, paddingLeft: 4 },
  input: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 15, color: c.text, padding: 14 },
  bio: { minHeight: 100, textAlignVertical: 'top' },
  counter: { color: c.textMuted, fontSize: 11, alignSelf: 'flex-end', marginTop: 4 },
  error: { color: c.danger, fontSize: 11, marginTop: 8 },
  note: { color: c.textMuted, fontSize: 11.5, lineHeight: 17, marginTop: 14 },
  button: { marginTop: 22, backgroundColor: c.cream, borderRadius: 15, padding: 15, alignItems: 'center' },
  disabled: { opacity: 0.45 },
  linksHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, marginBottom: 8 },
  linksTitle: { color: c.text, fontSize: 14, fontWeight: '800' },
  linksStar: { color: '#2589F5', fontSize: 15, fontWeight: '900' },
  verifyButton: { alignSelf: 'flex-start', marginTop: 8 },
  buttonText: { color: c.backgroundDeep, fontWeight: '800' },
});
