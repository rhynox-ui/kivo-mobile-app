import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { detectPhraseImport, serializeWalletSecret } from '../wallet/walletSecret';

// Recovery phrase only: Kivo is one wallet across Solana, EVM networks and
// NEAR, and only a phrase covers all of them (a single-network private key
// would leave the other networks on an unrelated wallet). Validation and
// address derivation run on this device; the phrase is only handed to the
// password step, which encrypts it into the local vault.
export function ImportWalletScreen({
  onBack,
  onPassword,
}: {
  onDone: () => void;
  onBack: () => void;
  onPassword: (secret: string) => void;
}) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(true);
  const detected = useMemo(() => detectPhraseImport(value), [value]);
  // Letters and spaces only: a phrase being typed (private keys contain digits),
  // so word suggestions start from the very first word.
  const looksLikeWords = /^[a-z\s]*$/i.test(value) && value.trim().length > 0;
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const current = words[words.length - 1] ?? '';
  const suggestions =
    reveal && looksLikeWords && current && !value.endsWith(' ')
      ? english.filter((word) => word.startsWith(current)).slice(0, 5)
      : [];
  // Replace the word being typed (whatever its case) with the picked one.
  const pick = (word: string) =>
    setValue(value.replace(/[a-z]*$/i, '') + word + ' ');
  const ok = detected.status === 'ok';
  const problem = detected.status === 'invalid' || detected.status === 'ambiguous' || detected.status === 'incomplete' ? detected.message : '';
  const submit = () => {
    if (detected.status === 'ok') onPassword(serializeWalletSecret(detected.secret));
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Import wallet</Text>
      </View>
      <Text style={styles.body}>
        Enter your 12 or 24-word recovery phrase. One phrase gives you the same wallet on Solana, Ethereum,
        Base, BNB Chain and every other Kivo network. Kivo checks it on this device and encrypts it here. It is
        never sent to Kivo.
      </Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="Recovery phrase (12 or 24 words)"
        placeholderTextColor={kivoTheme.colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        secureTextEntry={!reveal}
        multiline={reveal}
        style={[styles.input, !reveal && styles.inputHidden, problem ? styles.inputError : null]}
      />
      <View style={styles.row}>
        <Text style={styles.count}>
          {looksLikeWords ? `${words.length}/24 words` : 'Recovery phrase · 12 or 24 words. Private keys are not accepted.'}
        </Text>
        <Pressable onPress={() => setReveal(!reveal)} hitSlop={8}>
          <Text style={styles.toggle}>{reveal ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {suggestions.length > 0 && (
        <View style={styles.suggestions}>
          {suggestions.map((word) => (
            <Pressable key={word} onPress={() => pick(word)} style={styles.chip}>
              <Text style={styles.chipText}>{word}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.meta}>
        {problem ? <Text style={styles.error}>{problem}</Text> : null}
        {detected.status === 'ok' && (
          <View style={styles.detected}>
            <Text style={styles.valid}>Detected: {detected.label}</Text>
            {detected.addresses.map((row) => (
              <View key={row.network} style={styles.addressRow}>
                <Text style={styles.addressNetwork}>{row.network}</Text>
                <Text style={styles.address} selectable>{row.address}</Text>
              </View>
            ))}
            <Text style={styles.note}>Check this is the address you expect before importing.</Text>
          </View>
        )}
      </View>
      <Pressable disabled={!ok} onPress={submit} style={[styles.button, !ok && styles.disabled]}>
        <Text style={styles.buttonText}>Import securely</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background },
  content: { flexGrow: 1, padding: 24 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 },
  toggle: { color: kivoTheme.colors.cream, fontSize: 12, fontWeight: '800' },
  inputHidden: { minHeight: 56 },
  detected: { backgroundColor: kivoTheme.colors.surface, borderRadius: 14, padding: 12, marginTop: 4, gap: 6 },
  addressRow: { gap: 2 },
  addressNetwork: { color: kivoTheme.colors.textMuted, fontSize: 11, fontWeight: '700' },
  address: { color: kivoTheme.colors.text, fontSize: 12 },
  note: { color: kivoTheme.colors.textMuted, fontSize: 12, lineHeight: 17 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 28 },
  back: { color: kivoTheme.colors.cream, fontSize: 38, width: 35 },
  title: { color: kivoTheme.colors.text, fontSize: 22, fontWeight: '800' },
  body: { color: kivoTheme.colors.textMuted, fontSize: 14, lineHeight: 21 },
  input: {
    minHeight: 150,
    marginTop: 20,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    borderRadius: 16,
    backgroundColor: kivoTheme.colors.surface,
    color: kivoTheme.colors.text,
    padding: 16,
    textAlignVertical: 'top',
  },
  inputError: { borderColor: kivoTheme.colors.danger },
  suggestions: { flexDirection: 'row', gap: 8, paddingTop: 8, flexWrap: 'wrap' },
  chip: {
    backgroundColor: kivoTheme.colors.surfaceRaised,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipText: { color: kivoTheme.colors.text, fontSize: 12, fontWeight: '700' },
  meta: { minHeight: 40, paddingTop: 8, marginBottom: 16 },
  count: { color: kivoTheme.colors.textMuted, fontSize: 11 },
  error: { color: kivoTheme.colors.danger, fontSize: 12, marginTop: 4 },
  valid: { color: kivoTheme.colors.success, fontSize: 12, marginTop: 4 },
  button: {
    height: 58,
    borderRadius: 29,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 'auto',
    marginBottom: 12,
  },
  disabled: { opacity: 0.4 },
  buttonText: { color: kivoTheme.colors.backgroundDeep, fontWeight: '800' },
});
