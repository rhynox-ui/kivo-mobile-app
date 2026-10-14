import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoBadge({ children }: { children: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 20,
    paddingHorizontal: 7,
    height: 20,
    borderRadius: 10,
    backgroundColor: kivoTheme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: kivoTheme.colors.backgroundDeep, fontSize: 10, fontWeight: '800' },
});
