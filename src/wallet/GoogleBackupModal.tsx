import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { KivoModal } from '../components/KivoModal';
import { ErrorText, PasswordField, PrimaryButton } from '../onboarding/ui';
import { getWalletSession, recoverySecretWithPassword } from '../state/walletStore';
import { GoogleSignInCancelled, signInWithGoogle, writeBackup } from './googleBackup';

/** Settings → Security: save (or refresh) this wallet's encrypted backup in the user's Google Drive. */
export function GoogleBackupModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneEmail, setDoneEmail] = useState<string | null>(null);
  useEffect(() => { if (!visible) { setPassword(''); setError(''); setDoneEmail(null); setBusy(false); } }, [visible]);

  const backUp = async () => {
    setBusy(true); setError('');
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      // Checks the password first: only the real Kivo password may encrypt the backup.
      const mnemonic = await recoverySecretWithPassword(password);
      const account = await signInWithGoogle();
      await writeBackup(account, mnemonic, password, getWalletSession()?.address ?? '');
      setDoneEmail(account.email);
    } catch (e) {
      if (!(e instanceof GoogleSignInCancelled)) setError(e instanceof Error ? e.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KivoModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Google Drive backup</Text>
          {doneEmail ? (
            <>
              <Text style={styles.body}>Backed up to {doneEmail}. On a new phone, choose Continue with Google and enter your Kivo password.</Text>
              <PrimaryButton onPress={onClose}>Done</PrimaryButton>
            </>
          ) : (
            <>
              <Text style={styles.body}>Your recovery phrase is encrypted on this phone with your Kivo password, then saved to a hidden Kivo folder in your own Google Drive. Kivo never receives it.</Text>
              <View style={styles.field}><PasswordField value={password} onChangeText={setPassword} placeholder="Kivo password" autoFocus /></View>
              <ErrorText>{error}</ErrorText>
              <PrimaryButton onPress={() => void backUp()} disabled={!password || busy} loading={busy}>Back up with Google</PrimaryButton>
            </>
          )}
        </Pressable>
      </Pressable>
    </KivoModal>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 30, borderWidth: 1, borderColor: c.border, gap: 12 },
  title: { color: c.cream, fontSize: 20, fontWeight: '900' },
  body: { color: c.textMuted, fontSize: 14, lineHeight: 20 },
  field: { marginTop: 4 },
});
