import React, { type ReactNode } from 'react';
import { StyleSheet, Text, type TextProps } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoText({
  muted = false,
  children,
  ...props
}: { muted?: boolean; children: ReactNode } & TextProps) {
  return (
    <Text {...props} style={[styles.base, muted && styles.muted, props.style]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: { color: kivoTheme.colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: kivoTheme.colors.textMuted },
});
