import React from 'react';
import { Image, StyleSheet } from 'react-native';

type Props = {
  size?: number;
};

export function KivoMark({ size = 84 }: Props) {
  return (
    <Image
      accessibilityLabel="Kivo"
      resizeMode="cover"
      source={require('../assets/kivo-logo.png')}
      style={[styles.mark, { width: size, height: size, borderRadius: size * 0.24 }]}
    />
  );
}

const styles = StyleSheet.create({
  mark: {
    backgroundColor: '#063f3e',
  },
});
