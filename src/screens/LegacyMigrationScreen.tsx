import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { clearLegacyWallet, createVault, getLegacyMnemonic } from '../wallet/vault';

export function LegacyMigrationScreen({ onDone }: { onDone: (password: string) => void }) {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLegacyMnemonic().then(setMnemonic);
  }, []);

  const migrate = async () => {
    if (!mnemonic) {
      setError('No legacy wallet was found.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await createVault(mnemonic, password);
      await clearLegacyWallet();
      onDone(password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to migrate wallet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View>
        <Text style={styles.title}>Secure your Kivo wallet</Text>
        <Text style={styles.body}>
          Kivo now encrypts your wallet on this device with a password. Set one now to keep using
          this existing wallet.
        </Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={kivoTheme.colors.textMuted}
          secureTextEntry
          style={styles.input}
        />
        <TextInput
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="Confirm password"
          placeholderTextColor={kivoTheme.colors.textMuted}
          secureTextEntry
          style={styles.input}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <Pressable disabled={busy} onPress={migrate} style={[styles.button, busy && styles.disabled]}>
        {busy ? (
          <ActivityIndicator color={kivoTheme.colors.backgroundDeep} />
        ) : (
          <Text style={styles.buttonText}>Secure wallet</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: kivoTheme.colors.background,
    padding: 24,
    justifyContent: 'space-between',
  },
  title: { color: kivoTheme.colors.text, fontSize: 30, fontWeight: '800', marginTop: 50 },
  body: { color: kivoTheme.colors.textMuted, fontSize: 14, lineHeight: 21, marginTop: 10 },
  input: {
    height: 56,
    marginTop: 16,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    borderRadius: 14,
    backgroundColor: kivoTheme.colors.surface,
    color: kivoTheme.colors.text,
    paddingHorizontal: 16,
  },
  error: { color: '#E0443E', fontSize: 13, marginTop: 10 },
  button: {
    height: 58,
    borderRadius: 29,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: kivoTheme.colors.backgroundDeep, fontWeight: '800' },
});
