import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { isPlaceholderUsername, shortWalletLabel } from '@kivo/shared/profile/userLabel';
import { kivoAlert } from './KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { publishUsername } from '../state/session';
import { refreshReferrals } from '../state/referrals';

const c = kivoTheme.colors;

/**
 * One-tap "Publish your username" for an account whose @username exists only
 * on this phone: Kivo's server shows its short wallet instead, and referral
 * links cannot point at it. Publishing is one approval signed on the phone.
 */
export function PublishUsernamePrompt({ username, userId, onChooseAnother, onPublished }: { username: string; userId: string; onChooseAnother?: () => void; onPublished?: () => void }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const chosen = !isPlaceholderUsername(username);
  const wallet = shortWalletLabel(userId) ?? 'your wallet';
  const publish = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const name = await publishUsername();
      void refreshReferrals();
      kivoAlert('Username', `@${name} is now your Kivo username.`);
      onPublished?.();
    } catch (error) {
      kivoAlert('Username', error instanceof Error ? error.message : 'Could not publish your username. Try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Publish your username</Text>
      <Text style={styles.body}>
        {chosen ? `@${username} is only saved on this phone, so` : 'You have not chosen a username yet, so'} other people see you as {wallet} and your referral link does not work yet. Publishing takes one approval — a signed message, never a transaction.
      </Text>
      <View style={styles.actions}>
        {chosen ? (
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void publish(); }} style={[styles.button, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={c.backgroundDeep} /> : <Text style={styles.buttonText}>Publish @{username}</Text>}
          </Pressable>
        ) : null}
        {onChooseAnother ? (
          <Pressable accessibilityRole="button" disabled={busy} onPress={onChooseAnother} style={[chosen ? styles.secondary : styles.button, busy && styles.disabled]}>
            <Text style={chosen ? styles.secondaryText : styles.buttonText}>{chosen ? 'Choose another' : 'Choose username'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 16, borderRadius: 20, backgroundColor: 'rgba(183,226,123,0.12)', borderWidth: 1, borderColor: 'rgba(183,226,123,0.35)', gap: 8 },
  title: { color: c.text, fontSize: 16, fontWeight: '900' },
  body: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  button: { flexGrow: 1, height: 46, paddingHorizontal: 18, borderRadius: 23, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
  secondary: { height: 46, paddingHorizontal: 18, borderRadius: 23, borderWidth: 1, borderColor: 'rgba(244,240,199,0.35)', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: c.text, fontWeight: '800', fontSize: 14 },
  disabled: { opacity: 0.45 },
});
