import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { KivoMark } from '../components/KivoMark';
import { KivoButton } from '../components/KivoButton';
import { kivoTheme } from '../theme/kivoTheme';
import { getProfile } from '../state/profileStore';
import { validProfileUsername } from '../domain/socialValidation';
import {
  consumePendingReferralLink,
  getSuggestedReferrer,
  lookupReferrer,
  queueReferralClaim,
  subscribeReferralLinks,
} from '../state/referrals';

export function ReferralOnboardingScreen({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestedCode = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const apply = (username: string) => {
      suggestedCode.current = username;
      setCode(username);
      setError('');
    };
    const pending = consumePendingReferralLink();
    if (pending) apply(pending);
    else {
      void getSuggestedReferrer().then(username => {
        if (active && username) apply(username);
      });
    }
    const unsubscribe = subscribeReferralLinks(username => {
      consumePendingReferralLink();
      apply(username);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function finish() {
    const username = code.trim().replace(/^@/, '');
    if (!username) {
      onDone();
      return;
    }
    if (!validProfileUsername(username)) {
      setError('Enter a valid Kivo username, or skip this step.');
      return;
    }
    const ownUsername = getProfile().username.trim().replace(/^@/, '');
    if (ownUsername && ownUsername.toLowerCase() === username.toLowerCase()) {
      setError("You can't use your own username as a referral code.");
      return;
    }
    setBusy(true);
    setError('');
    try {
      await lookupReferrer(username);
      const source = suggestedCode.current?.toLowerCase() === username.toLowerCase()
        ? 'install'
        : 'manual';
      await queueReferralClaim(username, source);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : 'We could not verify that referral code. Check it and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function paste() {
    try {
      const value = await Clipboard.getString();
      if (value.trim()) {
        setCode(value.trim().replace(/^@/, ''));
        setError('');
      }
    } catch {
      setError('Could not access the clipboard. You can enter the code manually.');
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={onBack} hitSlop={12} style={styles.navAction}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <KivoMark size={42} />
        <Pressable accessibilityRole="button" onPress={onDone} hitSlop={12} style={styles.navAction}>
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>Enter referral code</Text>
        <Text style={styles.subtitle}>Get discounted trading fees.</Text>

        <View style={styles.inputRow}>
          <TextInput
            value={code}
            onChangeText={value => { setCode(value); setError(''); }}
            placeholder="Referral code"
            placeholderTextColor={kivoTheme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            importantForAutofill="no"
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => { void finish(); }}
            accessibilityLabel="Referral code"
            style={styles.input}
          />
          <View style={styles.separator} />
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void paste(); }} style={styles.pasteAction}>
            <Text style={styles.paste}>Paste</Text>
          </Pressable>
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>

      <View style={styles.footer}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onDone} hitSlop={10}>
          <Text style={styles.noCode}>I don't have one</Text>
        </Pressable>
        <KivoButton label="Finish setup →" onPress={() => { void finish(); }} loading={busy} disabled={busy} style={styles.finish} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B1E17',
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 16,
  },
  topBar: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navAction: {
    minWidth: 54,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: {
    color: kivoTheme.colors.cream,
    fontSize: 38,
    lineHeight: 42,
    fontWeight: '300',
  },
  skip: {
    color: kivoTheme.colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  content: {
    marginTop: 54,
  },
  title: {
    color: kivoTheme.colors.text,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  subtitle: {
    color: kivoTheme.colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 12,
  },
  inputRow: {
    minHeight: 62,
    marginTop: 40,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: kivoTheme.radius.lg,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    backgroundColor: kivoTheme.colors.surface,
    paddingLeft: 18,
    paddingRight: 8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: kivoTheme.colors.text,
    fontSize: 16,
    paddingVertical: 14,
  },
  separator: {
    width: 1,
    height: 28,
    backgroundColor: kivoTheme.colors.border,
    marginHorizontal: 10,
  },
  pasteAction: {
    minHeight: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paste: {
    color: kivoTheme.colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    color: kivoTheme.colors.danger,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  footer: {
    marginTop: 'auto',
    alignItems: 'center',
    gap: 22,
    paddingBottom: 4,
  },
  noCode: {
    color: kivoTheme.colors.text,
    fontSize: 15,
    fontWeight: '600',
    textDecorationLine: 'underline',
    textDecorationColor: kivoTheme.colors.creamMuted,
  },
  finish: {
    alignSelf: 'stretch',
    minHeight: 60,
    borderRadius: kivoTheme.radius.lg,
    backgroundColor: '#B7E27B',
    borderColor: '#B7E27B',
  },
});
