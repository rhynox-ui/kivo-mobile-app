import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { english, generateMnemonic } from 'viem/accounts';
import { kivoTheme } from '../theme/kivoTheme';
import { checkPasswordPolicy, MIN_PASSWORD_LENGTH } from '../wallet/passwordPolicy';
import { createLocalWallet, getWalletSession, importLocalWallet } from '../state/walletStore';
import { GoogleSignInCancelled, openBackup, readBackup, signInWithGoogle, writeBackup, type GoogleAccount, type WalletBackup } from '../wallet/googleBackup';
import { ErrorText, PasswordField, PrimaryButton, RequirementRow } from '../onboarding/ui';

// Continue with Google (FOMO-style onboarding, non-custodial):
//  - first time: set a Kivo password; Kivo creates the wallet on this phone and
//    saves it, encrypted with that password, to the user's own Google Drive;
//  - new phone: sign in with the same Google account and enter the password.

type Step =
  | { kind: 'signing-in' }
  | { kind: 'error'; message: string }
  | { kind: 'create'; account: GoogleAccount }
  | { kind: 'restore'; account: GoogleAccount; backup: WalletBackup }
  | { kind: 'backup-failed'; account: GoogleAccount; mnemonic: string; password: string; message: string };

export function GoogleWalletScreen({ onBack, onDone, onUsePhrase }: { onBack: () => void; onDone: (password: string) => void; onUsePhrase: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'signing-in' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = useCallback(async () => {
    setStep({ kind: 'signing-in' }); setError('');
    try {
      const account = await signInWithGoogle();
      const backup = await readBackup(account);
      setStep(backup ? { kind: 'restore', account, backup } : { kind: 'create', account });
    } catch (e) {
      if (e instanceof GoogleSignInCancelled) { onBack(); return; }
      setStep({ kind: 'error', message: e instanceof Error ? e.message : 'Google sign-in failed.' });
    }
  }, [onBack]);
  useEffect(() => { void start(); }, [start]);

  const policy = checkPasswordPolicy(password);
  const strong = policy.longEnough && policy.notCommon && policy.notPredictable;

  const create = async (account: GoogleAccount) => {
    setBusy(true); setError('');
    // Let the button show its spinner before the (slow) key stretching starts.
    await new Promise(resolve => setTimeout(resolve, 0));
    const mnemonic = generateMnemonic(english);
    try {
      await createLocalWallet(mnemonic, password);
    } catch (e) {
      setBusy(false); setError(e instanceof Error ? e.message : 'Could not create the wallet.'); return;
    }
    await saveBackup(account, mnemonic, password);
  };

  const saveBackup = async (account: GoogleAccount, mnemonic: string, pass: string) => {
    setBusy(true); setError('');
    try {
      await writeBackup(account, mnemonic, pass, getWalletSession()?.address ?? '');
      onDone(pass);
    } catch (e) {
      setStep({ kind: 'backup-failed', account, mnemonic, password: pass, message: e instanceof Error ? e.message : 'Google Drive did not save the backup.' });
    } finally {
      setBusy(false);
    }
  };

  const restore = async (backup: WalletBackup) => {
    setBusy(true); setError('');
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const mnemonic = await openBackup(backup, password);
      await importLocalWallet(mnemonic, password);
      onDone(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore the wallet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} hitSlop={10} disabled={busy}><Text style={styles.back}>‹ Back</Text></Pressable>

      {step.kind === 'signing-in' && (
        <View style={styles.center}>
          <ActivityIndicator color={kivoTheme.colors.accent} size="large" />
          <Text style={styles.body}>Connecting to Google…</Text>
        </View>
      )}

      {step.kind === 'error' && (
        <View>
          <Text style={styles.title}>Google sign-in didn't work</Text>
          <Text style={styles.body}>{step.message}</Text>
          <View style={styles.gap} />
          <PrimaryButton onPress={() => void start()}>Try again</PrimaryButton>
          <Pressable onPress={onUsePhrase} style={styles.link}><Text style={styles.linkText}>Use a recovery phrase instead</Text></Pressable>
        </View>
      )}

      {step.kind === 'create' && (
        <View>
          <Text style={styles.title}>Create your Kivo wallet</Text>
          <Text style={styles.body}>Signed in as {step.account.email}. Choose a Kivo password: it unlocks the app and encrypts your wallet backup in your own Google Drive. Kivo never sees the password or your keys.</Text>
          <View style={styles.field}><PasswordField value={password} onChangeText={setPassword} placeholder="Kivo password" autoFocus /></View>
          <View style={styles.field}><PasswordField value={confirm} onChangeText={setConfirm} placeholder="Confirm password" /></View>
          <View style={styles.checklist}>
            <RequirementRow met={policy.longEnough}>At least {MIN_PASSWORD_LENGTH} characters</RequirementRow>
            <RequirementRow met={policy.notCommon && policy.notPredictable}>Not common or predictable</RequirementRow>
            <RequirementRow met={confirm.length > 0 && confirm === password}>Passwords match</RequirementRow>
          </View>
          <Text style={styles.warning}>Remember this password. With your Google account it is the only way to restore the wallet on a new phone — Kivo cannot reset it.</Text>
          <ErrorText>{error}</ErrorText>
          {busy ? <Text style={styles.small}>Creating and encrypting your wallet — this takes a moment.</Text> : null}
          <PrimaryButton onPress={() => void create(step.account)} disabled={!strong || confirm !== password || busy} loading={busy}>Create wallet</PrimaryButton>
        </View>
      )}

      {step.kind === 'restore' && (
        <View>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.body}>Kivo found your wallet backup ({step.backup.evmAddress.slice(0, 6)}…{step.backup.evmAddress.slice(-4)}) in {step.account.email}'s Google Drive. Enter your Kivo password to restore it on this phone.</Text>
          <View style={styles.field}><PasswordField value={password} onChangeText={setPassword} placeholder="Kivo password" autoFocus /></View>
          <ErrorText>{error}</ErrorText>
          {busy ? <Text style={styles.small}>Decrypting your wallet on this phone…</Text> : null}
          <PrimaryButton onPress={() => void restore(step.backup)} disabled={!password || busy} loading={busy}>Restore wallet</PrimaryButton>
          <Pressable onPress={onUsePhrase} style={styles.link}><Text style={styles.linkText}>Forgot the password? Use your recovery phrase</Text></Pressable>
        </View>
      )}

      {step.kind === 'backup-failed' && (
        <View>
          <Text style={styles.title}>Wallet created — backup not saved</Text>
          <Text style={styles.body}>Your wallet is on this phone, but Google Drive didn't save the backup: {step.message}</Text>
          <Text style={styles.warning}>Without a backup, losing this phone means losing the wallet. Try again, or back it up later from Settings → Security.</Text>
          <View style={styles.gap} />
          <PrimaryButton onPress={() => void saveBackup(step.account, step.mnemonic, step.password)} loading={busy} disabled={busy}>Try backup again</PrimaryButton>
          <Pressable onPress={() => onDone(step.password)} style={styles.link} disabled={busy}><Text style={styles.linkText}>Continue without a backup for now</Text></Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  content: { padding: 24, paddingBottom: 48, flexGrow: 1 },
  back: { color: c.accent, fontWeight: '800', fontSize: 15, marginTop: 12, marginBottom: 20 },
  center: { alignItems: 'center', gap: 16, marginTop: 120 },
  title: { color: c.text, fontSize: 28, lineHeight: 34, fontWeight: '800' },
  body: { color: c.textMuted, fontSize: 15, lineHeight: 22, marginTop: 10 },
  field: { marginTop: 14 },
  checklist: { marginTop: 14, gap: 6 },
  warning: { color: c.creamMuted, fontSize: 13, lineHeight: 19, marginVertical: 14 },
  small: { color: c.textMuted, fontSize: 13, marginBottom: 10 },
  gap: { height: 20 },
  link: { alignItems: 'center', paddingVertical: 16 },
  linkText: { color: c.accent, fontWeight: '800', fontSize: 14 },
});
