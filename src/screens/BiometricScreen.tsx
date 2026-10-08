import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { enableBiometricUnlockWithPassword } from '../state/walletStore';

const KIVO_MARK = require('../assets/kivo-logo.png');

export function BiometricScreen({
  password,
  onContinue,
}: {
  password: string;
  onContinue: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      await enableBiometricUnlockWithPassword(password);
      onContinue();
    } catch (error) {
      Alert.alert(
        'Biometrics',
        error instanceof Error
          ? error.message
          : 'Unable to enable biometric wallet unlock.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.icon}>
          <Image source={KIVO_MARK} resizeMode="contain" style={styles.logo} />
        </View>
        <Text style={styles.title}>Unlock Kivo faster</Text>
        <Text style={styles.body}>
          Protect access to your wallet with your device biometrics. Your
          password is stored only in secure hardware.
        </Text>
      </View>

      <Pressable
        disabled={busy}
        onPress={enable}
        style={[styles.primary, busy && styles.disabled]}
      >
        {busy ? (
          <ActivityIndicator color={kivoTheme.colors.backgroundDeep} />
        ) : (
          <Text style={styles.primaryText}>Enable Biometrics</Text>
        )}
      </Pressable>

      <Pressable
        disabled={busy}
        onPress={onContinue}
        style={styles.secondary}
      >
        <Text style={styles.secondaryText}>Maybe Later</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: kivoTheme.colors.background,
    padding: 24,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    width: 132,
    height: 132,
    borderRadius: 40,
    backgroundColor: 'rgba(183,226,123,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 82,
    height: 82,
    borderRadius: 22,
  },
  title: {
    color: kivoTheme.colors.text,
    fontSize: 30,
    fontWeight: '700',
    marginTop: 36,
    textAlign: 'center',
  },
  body: {
    color: kivoTheme.colors.textMuted,
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
    maxWidth: 320,
    marginTop: 12,
  },
  primary: {
    height: 58,
    borderRadius: 29,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.6,
  },
  primaryText: {
    color: kivoTheme.colors.backgroundDeep,
    fontWeight: '700',
  },
  secondary: {
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: {
    color: kivoTheme.colors.textMuted,
    fontWeight: '600',
  },
});
