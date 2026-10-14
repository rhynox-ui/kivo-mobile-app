import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoHeader({
  title,
  eyebrow,
  right,
}: {
  title: string;
  eyebrow?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.copy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingBottom: 12,
  },
  copy: { flex: 1 },
  eyebrow: { color: kivoTheme.colors.accent, fontSize: 9, fontWeight: '800', letterSpacing: 2 },
  title: { color: kivoTheme.colors.text, fontSize: 30, fontWeight: '800', marginTop: 3 },
});
