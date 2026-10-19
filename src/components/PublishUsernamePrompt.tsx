import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { kivoAlert } from './KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { publishUsername } from '../state/session';
import { refreshReferrals } from '../state/referrals';

const c = kivoTheme.colors;

/**
 * One-tap "Publish your username" for an account whose @username exists only
 * on this phone (Kivo's server shows the wallet instead, and no referral link
 * can point at it). Publishing is one wallet approval signed on the phone.
 */
export function PublishUsernamePrompt({ username, onPublished, compact = false }: { username: string; onPublished?: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const publish = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await publishUsername();
      void refreshReferrals();
      onPublished?.();
    } catch (error) {
      kivoAlert('Username', error instanceof Error ? error.message : 'Could not publish your username. Try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={[styles.card, compact && styles.compact]}>
      <Text style={styles.title}>Publish your username</Text>
      <Text style={styles.body}>@{username} is only saved on this phone, so other people see your wallet address and your referral link does not work yet. Publish it with one wallet approval — a signed message, never a transaction.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void publish(); }} style={[styles.button, busy && styles.disabled]}>
        {busy ? <ActivityIndicator color={c.backgroundDeep} /> : <Text style={styles.buttonText}>Publish @{username}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16, padding: 16, borderRadius: 20, backgroundColor: 'rgba(183,226,123,0.12)', borderWidth: 1, borderColor: 'rgba(183,226,123,0.35)', gap: 8 },
  compact: { marginTop: 12 },
  title: { color: c.text, fontSize: 16, fontWeight: '900' },
  body: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  button: { height: 46, borderRadius: 23, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  buttonText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
  disabled: { opacity: 0.45 },
});
