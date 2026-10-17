import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import {
  getBiometryLabel,
  isBiometricAvailable,
  isBiometricUnlockEnabled,
} from '../wallet/biometricAuth';
import { disableBiometricUnlock } from '../state/walletStore';
import {
  AUTO_LOCK_OPTIONS,
  DEFAULT_AUTO_LOCK_MS,
  loadAutoLockMs,
  setAutoLockMs,
} from '../settings/autoLockPrefs';
import {
  loadGaslessTradingEnabled,
  setGaslessTradingEnabled,
} from '../settings/gaslessTradingPrefs';
import { RevealPhraseModal } from '../wallet/RevealPhraseModal';
import { ExportPrivateKeyModal } from '../wallet/ExportPrivateKeyModal';
import { EnableBiometricModal } from '../wallet/EnableBiometricModal';
import { GoogleBackupModal } from '../wallet/GoogleBackupModal';

export function SecurityScreen({ onBack }: { onBack: () => void }) {
  const [label, setLabel] = useState('biometric');
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [gasless, setGasless] = useState(true);
  const [auto, setAuto] = useState(DEFAULT_AUTO_LOCK_MS);
  const [showEnable, setShowEnable] = useState(false);
  const [googleBackup, setGoogleBackup] = useState(false);
  const [phrase, setPhrase] = useState(false);
  const [keys, setKeys] = useState(false);

  useEffect(() => {
    Promise.all([
      getBiometryLabel(),
      isBiometricAvailable(),
      isBiometricUnlockEnabled(),
      loadGaslessTradingEnabled(),
      loadAutoLockMs(),
    ]).then(([biometryLabel, biometricAvailable, biometricEnabled, gaslessEnabled, autoLockMs]) => {
      setLabel(biometryLabel);
      setAvailable(biometricAvailable);
      setEnabled(biometricEnabled);
      setGasless(gaslessEnabled);
      setAuto(autoLockMs);
    });
  }, []);

  const toggle = async (value: boolean) => {
    if (value) {
      setShowEnable(true);
    } else {
      const ok = await disableBiometricUnlock();
      if (ok) setEnabled(false);
    }
  };

  const confirm = () => {
    setEnabled(true);
    setShowEnable(false);
  };

  return (
    <View style={styles.root}>
      <Pressable onPress={onBack}>
        <Text style={styles.back}>‹</Text>
      </Pressable>
      <Text style={styles.title}>Security</Text>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.section}>BIOMETRIC UNLOCK</Text>
        <View style={styles.switchRow}>
          <Text style={styles.rowLabel}>{available ? 'Unlock with ' + label : 'Biometric unlock'}</Text>
          <Switch value={enabled} onValueChange={toggle} disabled={!available} />
        </View>
        <Text style={styles.section}>GASLESS TRADING (BETA)</Text>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Enable gasless trading to use Kivo.</Text>
            <Text style={styles.hint}>
              Relay sponsors supported trade execution, so no native ETH/BNB is required when a
              sponsored route is available.
            </Text>
          </View>
          <Switch
            value={gasless}
            onValueChange={(value) => {
              setGasless(value);
              setGaslessTradingEnabled(value);
            }}
          />
        </View>
        <Text style={styles.section}>RECOVERY PHRASE</Text>
        <Pressable onPress={() => setGoogleBackup(true)} style={styles.row}>
          <Text style={styles.rowLabel}>Back up to Google Drive</Text>
        </Pressable>
        <Text style={styles.hint}>
          Encrypted with your Kivo password and saved to your own Google Drive, so a new phone can restore
          this wallet with Google sign-in and your password.
        </Text>
        <Pressable onPress={() => setPhrase(true)} style={styles.row}>
          <Text style={styles.rowLabel}>Reveal recovery phrase</Text>
        </Pressable>
        <Text style={styles.hint}>
          Requires your password. Use this to double-check your backup or to import this same wallet
          into another app.
        </Text>
        <Pressable onPress={() => setKeys(true)} style={styles.row}>
          <Text style={styles.rowLabel}>Export private keys</Text>
        </Pressable>
        <Text style={styles.hint}>
          Derives your EVM, Solana, and NEAR account keys locally. Never share them.
        </Text>
        <Text style={styles.section}>AUTO-LOCK</Text>
        <Text style={styles.hint}>Lock the wallet after this much time in the background.</Text>
        {AUTO_LOCK_OPTIONS.map((option) => (
          <Pressable
            key={option.ms}
            style={styles.row}
            onPress={() => {
              setAuto(option.ms);
              setAutoLockMs(option.ms);
            }}
          >
            <Text style={styles.rowLabel}>{option.label}</Text>
            {auto === option.ms && <Text style={styles.check}>✓</Text>}
          </Pressable>
        ))}
      </ScrollView>
      <EnableBiometricModal
        visible={showEnable}
        biometryLabel={label}
        onClose={() => setShowEnable(false)}
        onEnabled={confirm}
      />
      {phrase && <RevealPhraseModal visible onClose={() => setPhrase(false)} />}
      <GoogleBackupModal visible={googleBackup} onClose={() => setGoogleBackup(false)} />
      {keys && <ExportPrivateKeyModal visible onClose={() => setKeys(false)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background, paddingHorizontal: 20 },
  back: { color: kivoTheme.colors.textMuted, fontSize: 38, width: 35 },
  title: {
    color: kivoTheme.colors.text,
    fontSize: 34,
    fontWeight: '800',
    marginTop: 6,
    marginBottom: 18,
  },
  section: {
    color: kivoTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: kivoTheme.colors.border,
  },
  rowLabel: { color: kivoTheme.colors.text, fontSize: 16, fontWeight: '500', flex: 1 },
  hint: { color: kivoTheme.colors.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  check: { color: kivoTheme.colors.text, fontSize: 18, fontWeight: '800' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: kivoTheme.colors.surface, borderRadius: 20, padding: 20 },
});
