import React from 'react';
import { StyleSheet, View } from 'react-native';
import { KivoMark } from './KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

export function KivoAvatar({ size = 48 }: { size?: number }) {
  return (
    <View style={[styles.root, { width: size, height: size, borderRadius: size * 0.34 }]}>
      <KivoMark size={size * 0.58} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: kivoTheme.colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
