import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { english, generateMnemonic } from 'viem/accounts';
import { kivoTheme } from '../theme/kivoTheme';
import { checkPasswordPolicy, MIN_PASSWORD_LENGTH } from '../wallet/passwordPolicy';
import { createLocalWallet, enableBiometricUnlockWithPassword, getWalletSession, importLocalWallet } from '../state/walletStore';
import { getBiometryLabel, isBiometricAvailable } from '../wallet/biometricAuth';
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
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(true);
  const [biometryLabel, setBiometryLabel] = useState('biometrics');
  const [checkingBiometrics, setCheckingBiometrics] = useState(true);

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

  useEffect(() => {
    let active = true;
    void (async () => {
      const available = await isBiometricAvailable();
      const label = await getBiometryLabel();
      if (!active) return;
      setBiometricAvailable(available);
      setBiometricEnabled(available);
      setBiometryLabel(label);
      setCheckingBiometrics(false);
    })();
    return () => { active = false; };
  }, []);

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
      if (biometricEnabled && biometricAvailable) {
        try {
          // Store the wallet password only in native Keychain/Keystore with
          // biometric/device-auth access controls; never in AsyncStorage.
          await enableBiometricUnlockWithPassword(pass);
        } catch {
          Alert.alert(
            'Backup saved',
            'Your encrypted Google Drive backup is safe, but biometric unlock was not enabled. You can enable it later in Settings → Security.',
            [{ text: 'Continue', onPress: () => onDone(pass) }],
            { cancelable: false },
          );
          return;
        }
      }
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
          <Text style={styles.title}>Secure your wallet</Text>
          <Text style={styles.body}>Signed in as {step.account.email}. Set up your backup password and device unlock in one step.</Text>
          <View style={styles.securityOption}>
            <View style={styles.securityIcon}><Text style={styles.securityIconText}>⌁</Text></View>
            <View style={styles.securityCopy}>
              <Text style={styles.securityTitle}>Enable Face ID / Touch ID</Text>
              <Text style={styles.securityBody}>{biometricAvailable ? `Unlock your wallet instantly with ${biometryLabel}.` : checkingBiometrics ? 'Checking device biometric support…' : 'Biometrics are not available or enrolled on this device. You can use your password instead.'}</Text>
            </View>
            <Switch
              value={biometricAvailable && biometricEnabled}
              onValueChange={setBiometricEnabled}
              disabled={!biometricAvailable || checkingBiometrics || busy}
              trackColor={{ false: '#315B55', true: kivoTheme.colors.accent }}
              thumbColor={kivoTheme.colors.cream}
              accessibilityLabel="Enable Face ID or Touch ID"
            />
          </View>
          <View style={styles.securityDivider} />
          <Text style={styles.securityTitle}>Kivo backup password</Text>
          <Text style={styles.securityBody}>Used to decrypt your Google Drive backup on a new device.</Text>
          <View style={styles.field}><PasswordField value={password} onChangeText={setPassword} placeholder="Enter Password" autoFocus /></View>
          <View style={styles.field}><PasswordField value={confirm} onChangeText={setConfirm} placeholder="Confirm Password" /></View>
          <View style={styles.checklist}>
            <RequirementRow met={policy.longEnough}>At least {MIN_PASSWORD_LENGTH} characters</RequirementRow>
            <RequirementRow met={policy.notCommon && policy.notPredictable}>Not common or predictable</RequirementRow>
            <RequirementRow met={confirm.length > 0 && confirm === password}>Passwords match</RequirementRow>
          </View>
          <Text style={styles.warning}>Remember this password. With your Google account it is the only way to restore the wallet on a new phone — Kivo cannot reset it.</Text>
          <ErrorText>{error}</ErrorText>
          {busy ? <Text style={styles.small}>Creating and encrypting your wallet — this takes a moment.</Text> : null}
          <PrimaryButton onPress={() => void create(step.account)} disabled={!strong || confirm !== password || busy || checkingBiometrics} loading={busy}>Complete Wallet Setup</PrimaryButton>
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
  securityOption: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, marginTop: 18 },
  securityIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(183,226,123,0.10)', alignItems: 'center', justifyContent: 'center' },
  securityIconText: { color: c.accent, fontSize: 30, fontWeight: '700' },
  securityCopy: { flex: 1 },
  securityTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  securityBody: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  securityDivider: { height: 1, backgroundColor: c.border, marginBottom: 18 },
  small: { color: c.textMuted, fontSize: 13, marginBottom: 10 },
  gap: { height: 20 },
  link: { alignItems: 'center', paddingVertical: 16 },
  linkText: { color: c.accent, fontWeight: '800', fontSize: 14 },
});
