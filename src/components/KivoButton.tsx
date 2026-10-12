import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

type Variant = 'primary' | 'secondary' | 'danger';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
};

export function KivoButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}: Props) {
  const primary = variant === 'primary';
  const danger = variant === 'danger';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : danger ? styles.danger : styles.secondary,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? kivoTheme.colors.backgroundDeep : kivoTheme.colors.cream} />
      ) : (
        <Text style={[styles.label, primary ? styles.primaryLabel : styles.secondaryLabel]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: kivoTheme.radius.pill,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  primary: {
    backgroundColor: kivoTheme.colors.cream,
    borderColor: kivoTheme.colors.cream,
  },
  secondary: {
    backgroundColor: kivoTheme.colors.surface,
    borderColor: kivoTheme.colors.border,
  },
  danger: {
    backgroundColor: kivoTheme.colors.danger,
    borderColor: kivoTheme.colors.danger,
  },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
  label: { fontSize: 14, fontWeight: '800' },
  primaryLabel: { color: kivoTheme.colors.backgroundDeep },
  secondaryLabel: { color: kivoTheme.colors.cream },
});
