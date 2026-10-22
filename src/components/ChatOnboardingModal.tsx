import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, enableSocial, socialReady } from '../state/session';
import { getWalletSession, subscribeToWallet } from '../state/walletStore';
import { KivoMark } from './KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
const dismissedKey = (address: string) => `dismissed_chat_prompt_${address.toLowerCase()}`;

export function ChatOnboardingModal() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkGeneration = useRef(0);

  const checkWallet = useCallback((address: string | null) => {
    const generation = ++checkGeneration.current;
    if (timer.current) clearTimeout(timer.current);
    setWalletAddress(address);
    if (!address) { setVisible(false); return; }
    timer.current = setTimeout(() => {
      void (async () => {
        // Give the wallet activation flow time to restore the secure API session.
        if (socialReady() && api.isSignedIn(address)) { setVisible(false); return; }
        const restored = await api.restore(address).catch(() => false);
        if (generation !== checkGeneration.current || getWalletSession()?.address.toLowerCase() !== address.toLowerCase()) return;
        if (restored || socialReady()) { setVisible(false); return; }
        try {
          const raw = await AsyncStorage.getItem(dismissedKey(address));
          const dismissedAt = raw ? Number(raw) : 0;
          if (dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_TTL_MS) { setVisible(false); return; }
        } catch { /* Prompt should still work when local preferences are unavailable. */ }
        if (generation === checkGeneration.current) setVisible(true);
      })();
    }, 700);
  }, []);

  useEffect(() => {
    checkWallet(getWalletSession()?.address ?? null);
    const unsubscribeWallet = subscribeToWallet(wallet => checkWallet(wallet?.address ?? null));
    const unsubscribeApi = api.onSessionChange(() => {
      const address = getWalletSession()?.address ?? null;
      if (address && api.isSignedIn(address)) setVisible(false);
    });
    return () => {
      checkGeneration.current++;
      if (timer.current) clearTimeout(timer.current);
      unsubscribeWallet();
      unsubscribeApi();
    };
  }, [checkWallet]);

  const skip = async () => {
    if (walletAddress) {
      try { await AsyncStorage.setItem(dismissedKey(walletAddress), String(Date.now())); } catch {}
    }
    setVisible(false);
  };

  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await enableSocial();
      setVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not enable Kivo chats.';
      // Keep the prompt available after cancellation or network errors.
      setBusy(false);
      setErrorText(message);
      return;
    }
    setBusy(false);
  };

  const [errorText, setErrorText] = useState('');
  useEffect(() => { if (!visible) setErrorText(''); }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => { void skip(); }}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.mark}><KivoMark size={64} /></View>
          <Text style={styles.title}>Turn on Kivo chats</Text>
          <Text style={styles.description}>Sign a short message with your wallet to prove it’s you. It is free, it is not a transaction, and it cannot move funds.</Text>
          <View style={styles.benefits}>
            <Text style={styles.benefit}>▢  Your chat history is stored on this device.</Text>
            <Text style={styles.benefit}>✓  Kivo only relays messages and keeps them 30 days.</Text>
            <Text style={styles.benefit}>◇  Your username is display only — your wallet is your identity.</Text>
          </View>
          {errorText ? <Text accessibilityRole="alert" style={styles.error}>{errorText}</Text> : null}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void turnOn(); }} style={({ pressed }) => [styles.primary, pressed && styles.pressed, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep} /> : <Text style={styles.primaryText}>♢  Turn on chats</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void skip(); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Skip for now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 12, 10, 0.78)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 480, borderRadius: 24, borderWidth: 1, borderColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.surface, padding: 24, alignItems: 'center' },
  mark: { width: 88, height: 88, borderRadius: 24, backgroundColor: kivoTheme.colors.backgroundDeep, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  title: { color: kivoTheme.colors.text, fontSize: 25, fontWeight: '800', textAlign: 'center', marginBottom: 14 },
  description: { color: kivoTheme.colors.textMuted, fontSize: 16, lineHeight: 24, textAlign: 'center', marginBottom: 24 },
  benefits: { width: '100%', gap: 14, marginBottom: 24 },
  benefit: { color: kivoTheme.colors.textMuted, fontSize: 15, lineHeight: 22 },
  error: { color: '#FF8585', fontSize: 13, lineHeight: 19, marginBottom: 12, alignSelf: 'stretch' },
  primary: { minHeight: 58, width: '100%', borderRadius: 18, backgroundColor: kivoTheme.colors.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: kivoTheme.colors.backgroundDeep, fontSize: 17, fontWeight: '800' },
  secondary: { paddingVertical: 14, paddingHorizontal: 20, marginTop: 6 },
  secondaryText: { color: kivoTheme.colors.textMuted, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.65 },
});
