import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

const slides = [
  {
    title: 'More than a wallet',
    body: 'Chat, connect, trade and manage your assets in one place.',
  },
  {
    title: 'Multi-chain by default',
    body: 'Use your supported assets across networks without making blockchain complexity your problem.',
  },
  {
    title: 'Your keys. Your control.',
    body: 'Kivo is designed around non-custodial wallet ownership and explicit transaction authorization.',
  },
];

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  const last = index === slides.length - 1;

  function next() {
    if (last) {
      onDone();
      return;
    }
    setIndex((value) => value + 1);
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={onDone} style={styles.skip}>
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>

      <View style={styles.hero}>
        <View style={styles.glow}>
          <KivoMark size={78} />
        </View>
        <Text style={styles.title}>{slide.title}</Text>
        <Text style={styles.body}>{slide.body}</Text>
      </View>

      <View style={styles.footer}>
        <View style={styles.dots}>
          {slides.map((_, dot) => (
            <View
              key={dot}
              style={[styles.dot, dot === index && styles.dotActive]}
            />
          ))}
        </View>
        <Pressable onPress={next} style={styles.next}>
          <Text style={styles.nextText}>{last ? 'Get Started' : '→'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: kivoTheme.colors.background,
    padding: 24,
  },
  skip: {
    alignSelf: 'flex-end',
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  skipText: {
    color: kivoTheme.colors.textMuted,
    fontSize: 14,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
  },
  glow: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(183,226,123,0.10)',
    marginBottom: 56,
  },
  title: {
    color: kivoTheme.colors.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.8,
    maxWidth: 320,
  },
  body: {
    color: kivoTheme.colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 16,
    maxWidth: 340,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
  },
  dots: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(183,226,123,0.18)',
  },
  dotActive: {
    width: 28,
    backgroundColor: kivoTheme.colors.accent,
  },
  next: {
    minWidth: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: kivoTheme.colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  nextText: {
    color: kivoTheme.colors.backgroundDeep,
    fontSize: 16,
    fontWeight: '700',
  },
});
