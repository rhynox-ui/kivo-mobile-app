import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {kivoTheme} from '../theme/kivoTheme';
import {unlockWalletWithPassword} from '../state/walletStore';
import {VaultLockedError} from '../wallet/vault';

export function WalletUnlockScreen({onUnlocked}: {onUnlocked: () => void}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockMs, setLockMs] = useState(0);

  useEffect(() => {
    if (lockMs <= 0) return;
    const timer = setInterval(() => setLockMs(value => Math.max(0, value - 1000)), 1000);
    return () => clearInterval(timer);
  }, [lockMs > 0]);

  const unlock = async () => {
    if (lockMs > 0) return;
    setBusy(true);
    setError('');
    try {
      await unlockWalletWithPassword(password);
      onUnlocked();
    } catch (cause) {
      if (cause instanceof VaultLockedError) {
        setLockMs(cause.remainingMs);
        setError('Too many incorrect attempts.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Incorrect password.');
      }
    } finally {
      setBusy(false);
    }
  };

  const seconds = Math.ceil(lockMs / 1000);
  return (
    <View style={styles.root}>
      <View style={styles.center}>
        <Text style={styles.title}>Unlock Kivo</Text>
        <Text style={styles.body}>Enter your wallet password to unlock your device wallet.</Text>
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
        {lockMs > 0 ? (
          <Text style={styles.lock}>
            Try again in {seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`}.
          </Text>
        ) : null}
      </View>
      <Pressable
        disabled={!password || busy || lockMs > 0}
        onPress={unlock}
        style={[styles.button, (!password || busy || lockMs > 0) && styles.disabled]}
      >
        {busy
          ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep} />
          : <Text style={styles.buttonText}>{lockMs > 0 ? 'Locked' : 'Unlock'}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: kivoTheme.colors.background, padding: 24, justifyContent: 'space-between'},
  center: {justifyContent: 'center', flex: 1},
  title: {color: kivoTheme.colors.text, fontSize: 32, fontWeight: '800', textAlign: 'center'},
  body: {color: kivoTheme.colors.textMuted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10},
  input: {height: 56, marginTop: 24, borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 14, backgroundColor: kivoTheme.colors.surface, color: kivoTheme.colors.text, paddingHorizontal: 16},
  error: {color: kivoTheme.colors.danger, fontSize: 13, marginTop: 10, textAlign: 'center'},
  lock: {color: kivoTheme.colors.danger, fontSize: 12, textAlign: 'center', marginTop: 8},
  button: {height: 58, borderRadius: 29, backgroundColor: kivoTheme.colors.cream, alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  disabled: {opacity: 0.4},
  buttonText: {color: kivoTheme.colors.backgroundDeep, fontWeight: '800'},
});
