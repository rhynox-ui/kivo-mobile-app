import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { loadVault, unlockVaultMnemonic } from './vault';
import { enableBiometricUnlock } from './biometricAuth';

export function EnableBiometricModal({
  visible,
  biometryLabel,
  onClose,
  onEnabled,
}: {
  visible: boolean;
  biometryLabel: string;
  onClose: () => void;
  onEnabled: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    if (busy) return;
    setPassword('');
    setError('');
    onClose();
  };

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      const vault = await loadVault();
      if (!vault) throw new Error('No wallet found on this device.');
      await unlockVaultMnemonic(vault, password);
      const ok = await enableBiometricUnlock(password);
      if (!ok) throw new Error('Unable to enable biometric unlock.');
      setPassword('');
      onEnabled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Incorrect password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.title}>Enable {biometryLabel} unlock</Text>
            <Pressable onPress={close}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.body}>
            Confirm your wallet password once to enable {biometryLabel} unlock. The password remains
            in this device's secure hardware and is never sent to Kivo.
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={kivoTheme.colors.textMuted}
            secureTextEntry
            autoFocus
            style={styles.input}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            disabled={!password || busy}
            onPress={enable}
            style={[styles.button, (!password || busy) && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color={kivoTheme.colors.backgroundDeep} />
            ) : (
              <Text style={styles.buttonText}>Enable</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: kivoTheme.colors.surface,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    borderRadius: 22,
    padding: 20,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { color: kivoTheme.colors.text, fontSize: 17, fontWeight: '800', flex: 1 },
  close: { color: kivoTheme.colors.textMuted, fontSize: 16 },
  body: { color: kivoTheme.colors.textMuted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
  input: {
    height: 54,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    borderRadius: 14,
    backgroundColor: kivoTheme.colors.background,
    color: kivoTheme.colors.text,
    paddingHorizontal: 15,
  },
  error: { color: kivoTheme.colors.danger, fontSize: 12, marginTop: 8 },
  button: {
    height: 54,
    borderRadius: 27,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  disabled: { opacity: 0.45 },
  buttonText: { color: kivoTheme.colors.backgroundDeep, fontWeight: '800' },
});
