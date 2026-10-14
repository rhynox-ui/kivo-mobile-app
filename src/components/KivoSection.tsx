import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginBottom: 18 },
  title: {
    color: kivoTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 9,
  },
});
