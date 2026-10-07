// Kivo splash — the same code-driven brand moment as Mango Pro's
// IntroSplash (mark, wordmark and accent bar animating in with a small
// overshoot, tagline fade, then the overlay fades out), with Kivo's
// graphics: the Kivo mark, the cream "kivo" wordmark and the
// "Chat • Connect • Trade" tagline on the dark teal ground.
//
// First launch on a device plays the full ~3.6s sequence; returning
// users (a wallet already exists) get a ~0.9s version so opening the app
// never feels stuck.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

const KIVO_MARK = require('../assets/kivo-logo.png');
const REVEAL_EASING = Easing.bezier(0.34, 1.56, 0.64, 1);

export function SplashScreen({ onDone, quick }: { onDone?: () => void; quick?: boolean }) {
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const markOpacity = useRef(new Animated.Value(0)).current;
  const markScale = useRef(new Animated.Value(0.8)).current;
  const wordmarkOpacity = useRef(new Animated.Value(0)).current;
  const wordmarkScale = useRef(new Animated.Value(0.9)).current;
  const barScale = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = quick
      ? { markDelay: 40, markDur: 220, wordDelay: 160, wordDur: 220, barDelay: 320, barDur: 120, tagDelay: 380, tagDur: 120, fadeDelay: 640, fadeDur: 220 }
      : { markDelay: 250, markDur: 550, wordDelay: 750, wordDur: 520, barDelay: 1450, barDur: 350, tagDelay: 1850, tagDur: 420, fadeDelay: 3100, fadeDur: 500 };
    const sequence = Animated.parallel([
      Animated.sequence([Animated.delay(t.markDelay), Animated.parallel([
        Animated.timing(markOpacity, { toValue: 1, duration: t.markDur, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(markScale, { toValue: 1, duration: t.markDur, easing: REVEAL_EASING, useNativeDriver: true }),
      ])]),
      Animated.sequence([Animated.delay(t.wordDelay), Animated.parallel([
        Animated.timing(wordmarkOpacity, { toValue: 1, duration: t.wordDur, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(wordmarkScale, { toValue: 1, duration: t.wordDur, easing: REVEAL_EASING, useNativeDriver: true }),
      ])]),
      Animated.sequence([Animated.delay(t.barDelay), Animated.timing(barScale, { toValue: 1, duration: t.barDur, easing: Easing.out(Easing.cubic), useNativeDriver: true })]),
      Animated.sequence([Animated.delay(t.tagDelay), Animated.timing(taglineOpacity, { toValue: 1, duration: t.tagDur, easing: Easing.out(Easing.cubic), useNativeDriver: true })]),
      Animated.sequence([Animated.delay(t.fadeDelay), Animated.timing(overlayOpacity, { toValue: 0, duration: t.fadeDur, easing: Easing.in(Easing.cubic), useNativeDriver: true })]),
    ]);
    sequence.start(({ finished }) => { if (finished) onDone?.(); });
    return () => sequence.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Animated.Image source={KIVO_MARK} resizeMode="contain" style={[styles.mark, { opacity: markOpacity, transform: [{ scale: markScale }] }]} />
        <Animated.Text style={[styles.wordmark, { opacity: wordmarkOpacity, transform: [{ scale: wordmarkScale }] }]}>kivo</Animated.Text>
        <Animated.View style={[styles.bar, { transform: [{ scaleX: barScale }] }]} />
        <Animated.Text style={[styles.tagline, { opacity: taglineOpacity }]}>Chat  •  Connect  •  Trade</Animated.Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background },
  overlay: { flex: 1, backgroundColor: kivoTheme.colors.backgroundDeep, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 112, height: 112, borderRadius: 30, marginBottom: 14 },
  wordmark: { color: kivoTheme.colors.cream, fontSize: 58, fontWeight: '800', letterSpacing: -2 },
  bar: { width: 46, height: 3, borderRadius: 2, backgroundColor: kivoTheme.colors.accent, marginTop: 14, marginBottom: 18 },
  tagline: { color: kivoTheme.colors.creamMuted, fontSize: 14, letterSpacing: 1.6 },
});
