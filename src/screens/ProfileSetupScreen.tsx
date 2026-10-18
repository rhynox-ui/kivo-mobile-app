import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';
import { validProfileUsername } from '../domain/socialValidation';
import { updateProfile } from '../state/profileStore';
import { kivoAlert } from '../components/KivoAlert';
import { consumePendingReferralLink, getSuggestedReferrer, queueReferralClaim, subscribeReferralLinks } from '../state/referrals';

export function ProfileSetupScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  // Optional "Who referred you?": pre-filled from a referral link or the Play install referrer.
  const [referrer, setReferrer] = useState('');
  const suggested = useRef<string | null>(null);
  const referrerClean = referrer.trim().replace(/^@/, '');
  const referrerValid = !referrerClean || validProfileUsername(referrerClean);
  const valid = validProfileUsername(username.trim()) && referrerValid;

  useEffect(() => {
    let active = true;
    const apply = (code: string) => { suggested.current = code; setReferrer(code); };
    const pending = consumePendingReferralLink();
    if (pending) apply(pending);
    else void getSuggestedReferrer().then(code => { if (active && code && !suggested.current) setReferrer(current => { if (current) return current; suggested.current = code; return code; }); });
    const unsubscribe = subscribeReferralLinks(code => { consumePendingReferralLink(); apply(code); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const submit = () => {
    try {
      updateProfile({ username, bio: 'Building on-chain.' });
      if (referrerClean && referrerClean.toLowerCase() !== username.trim().toLowerCase()) {
        const fromLink = Boolean(suggested.current) && suggested.current!.toLowerCase() === referrerClean.toLowerCase();
        // Claimed as soon as this account is signed in to Kivo (now, or after the first sign-in).
        void queueReferralClaim(referrerClean, fromLink ? 'install' : 'manual');
      }
      onDone();
    } catch (error) {
      kivoAlert(
        'Profile',
        error instanceof Error ? error.message : 'Unable to create your profile.',
      );
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>YOUR KIVO IDENTITY</Text>
      <View style={styles.avatar}>
        <KivoMark size={54} />
      </View>
      <Text style={styles.title}>Create your profile</Text>
      <Text style={styles.body}>Choose the identity people will see when you chat and trade.</Text>
      <Text style={styles.label}>Username</Text>
      <View style={styles.username}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={username}
          onChangeText={setUsername}
          placeholder="yourname"
          placeholderTextColor={kivoTheme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="username"
          style={styles.input}
        />
      </View>
      <Text style={styles.hint}>3–32 characters: letters, numbers and underscores.</Text>
      <Text style={styles.label}>Who referred you? <Text style={styles.optional}>(optional)</Text></Text>
      <View style={styles.username}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={referrer}
          onChangeText={setReferrer}
          placeholder="friend's username"
          placeholderTextColor={kivoTheme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          style={styles.input}
        />
      </View>
      <Text style={[styles.hint, !referrerValid && styles.invalid]}>{referrerValid ? 'Joined with a friend? They earn rewards and you get 10% off trading fees.' : 'Enter a valid username, or leave it empty.'}</Text>
      <Pressable
        onPress={submit}
        disabled={!valid}
        style={[styles.button, !valid && styles.disabled]}
      >
        <Text style={styles.buttonText}>Enter Kivo</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: kivoTheme.colors.background },
  container: { flexGrow: 1, backgroundColor: kivoTheme.colors.background, padding: 24 },
  optional: { color: kivoTheme.colors.textMuted, fontWeight: '500' },
  invalid: { color: kivoTheme.colors.danger },
  eyebrow: {
    color: kivoTheme.colors.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginTop: 28,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(183,226,123,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 44,
  },
  title: { color: kivoTheme.colors.text, fontSize: 30, fontWeight: '700', marginTop: 34 },
  body: { color: kivoTheme.colors.textMuted, fontSize: 15, lineHeight: 22, marginTop: 10 },
  label: {
    color: kivoTheme.colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 34,
    marginBottom: 8,
  },
  username: {
    height: 58,
    borderRadius: 16,
    backgroundColor: kivoTheme.colors.surface,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  at: { color: kivoTheme.colors.accent, fontSize: 18, fontWeight: '700', marginLeft: 16 },
  input: { flex: 1, color: kivoTheme.colors.text, fontSize: 16, paddingHorizontal: 8 },
  hint: { color: kivoTheme.colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 12 },
  button: {
    height: 58,
    borderRadius: 29,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 'auto',
    marginBottom: 12,
    minHeight: 58,
  },
  disabled: { opacity: 0.4 },
  buttonText: { color: kivoTheme.colors.backgroundDeep, fontWeight: '700' },
});
