import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

type Props = {
  onCreate: () => void;
  onImport: () => void;
};

export function WalletSetupScreen({ onCreate, onImport }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>KIVO WALLET</Text>
      <Text style={styles.title}>Set up your wallet</Text>
      <Text style={styles.subtitle}>
        Fund your Kivo wallet with USDC and trade tokens from that balance across supported networks, without worrying about gas.
      </Text>

      <View style={styles.art}>
        <KivoMark size={92} />
      </View>

      <View style={styles.options}>
        <Option title="Create New Wallet" body="A new wallet secured on this device" onPress={onCreate} />
        <Option title="Import Wallet" body="Use an existing recovery phrase" onPress={onImport} />
      </View>
    </View>
  );
}

function Option({
  title,
  body,
  onPress,
}: {
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.option}>
      <View style={styles.icon}>
        <KivoMark size={28} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionBody}>{body}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: kivoTheme.colors.background,
    padding: 24,
  },
  eyebrow: {
    color: kivoTheme.colors.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginTop: 28,
  },
  title: {
    color: kivoTheme.colors.text,
    fontSize: 34,
    fontWeight: '700',
    marginTop: 10,
  },
  subtitle: {
    color: kivoTheme.colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 12,
  },
  art: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  options: {
    gap: 12,
    paddingBottom: 18,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: kivoTheme.colors.surface,
    borderRadius: kivoTheme.radius.md,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    padding: 14,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(183,226,123,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    marginLeft: 14,
  },
  optionTitle: {
    color: kivoTheme.colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  optionBody: {
    color: kivoTheme.colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  chevron: {
    color: kivoTheme.colors.creamMuted,
    fontSize: 26,
    paddingHorizontal: 4,
  },
});
