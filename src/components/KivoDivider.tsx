import React from 'react';
import { StyleSheet, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoDivider() {
  return <View style={styles.line} />;
}

const styles = StyleSheet.create({
  line: { height: 1, backgroundColor: kivoTheme.colors.border },
});
