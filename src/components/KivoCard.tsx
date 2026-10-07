import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoCard({ style, children, ...props }: ViewProps) {
  return (
    <View {...props} style={[styles.card, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: kivoTheme.colors.surface,
    borderRadius: kivoTheme.radius.lg,
    borderWidth: 1,
    borderColor: kivoTheme.colors.border,
    padding: kivoTheme.spacing.md,
  },
});
