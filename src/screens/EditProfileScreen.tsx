import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS } from '@kivo/shared/api/types';
import { validBio, validProfileUsername } from '../domain/socialValidation';
import { getProfile, updateProfile } from '../state/profileStore';
import { api, socialReady } from '../state/session';
import { signMessageWithLocalWallet } from '../state/walletStore';
import { getWalletSession } from '../state/walletStore';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

export function EditProfileScreen({ onBack }: { onBack: () => void }) {
  const current = getProfile();
  const [name, setName] = useState(current.username);
  const [bio, setBio] = useState(current.bio);
  const [avatarUri, setAvatarUri] = useState<string | undefined>(current.avatarUri);
  const [avatarFile, setAvatarFile] = useState<{ uri: string; type: string; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const username = name.replace(/^@/, '').toLowerCase();
  const valid = validProfileUsername(username) && validBio(bio);
  const wallet = getWalletSession();

  const pickAvatar = async () => {
    // Square-ish 256px JPEG straight from the picker keeps avatars under the 48 KB cap.
    const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, maxWidth: API_LIMITS.avatarEdge, maxHeight: API_LIMITS.avatarEdge, quality: 0.7 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    if (asset.fileSize && asset.fileSize > API_LIMITS.maxAvatarBytes) { Alert.alert('Avatar', 'That photo is too large even after compression. Try another one.'); return; }
    setAvatarUri(asset.uri);
    setAvatarFile({ uri: asset.uri, type: asset.type === 'image/png' ? 'image/png' : 'image/jpeg', size: asset.fileSize ?? 0 });
  };

  const save = async () => {
    setBusy(true);
    try {
      let finalAvatar = avatarUri;
      if (socialReady()) {
        const avatarAction: 'keep' | 'remove' | 'upload' = avatarFile ? 'upload' : avatarUri ? 'keep' : 'remove';
        const approval = await api.requestProfileApproval({ username, bio, avatarAction });
        const signature = await signMessageWithLocalWallet(approval.message);
        let avatarKey: string | null | undefined;
        if (avatarFile) {
          const bytes = await (await fetch(avatarFile.uri)).blob();
          const uploaded = await api.uploadImage(bytes, avatarFile.type, 'avatar');
          avatarKey = uploaded.key;
        } else if (avatarAction === 'remove') avatarKey = null;
        const saved = await api.updateProfile({
          username,
          bio,
          ...(avatarKey !== undefined ? { avatarKey } : {}),
          approvalNonce: approval.nonce,
          approvalSignature: signature,
          approvalAvatarAction: avatarAction,
        });
        finalAvatar = saved.avatarUrl ?? undefined;
      }
      updateProfile({ username, bio, avatarUri: finalAvatar });
      if (!socialReady()) Alert.alert('Profile', 'Saved on this phone. Turn on chats to publish your @username to Kivo.');
      onBack();
    } catch (error) {
      Alert.alert('Profile', error instanceof Error ? error.message : 'Unable to save profile.');
    } finally { setBusy(false); }
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
      <Text style={styles.note}>Wallet {wallet ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : ''} stays your identity. Changing your username or photo never changes which wallet owns this profile.</Text>
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
  buttonText: { color: c.backgroundDeep, fontWeight: '800' },
});
