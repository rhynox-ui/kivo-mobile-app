import React from 'react';
import { StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

type Props = TextInputProps & {
  label?: string;
  error?: string;
};

export function KivoInput({ label, error, style, ...props }: Props) {
  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        {...props}
        placeholderTextColor={kivoTheme.colors.textMuted}
        style={[styles.input, style]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 7 },
  label: { color: kivoTheme.colors.textMuted, fontSize: 12, fontWeight: '700' },
  input: {
    minHeight: 52,
    borderRadius: kivoTheme.radius.md,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    backgroundColor: kivoTheme.colors.surface,
    color: kivoTheme.colors.text,
    paddingHorizontal: 15,
    fontSize: 15,
  },
  error: { color: kivoTheme.colors.danger, fontSize: 12 },
});
