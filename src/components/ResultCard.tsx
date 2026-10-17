import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

// One look for every finished action (trade, convert, withdraw): the asset is
// the hero with a small ✓/✕ badge, the amount that matters is the headline,
// and a failure always says first whether any money moved.

export type ResultTone = 'success' | 'pending' | 'error';
export type ResultAsset = { symbol: string; imageUrl?: string | null; amount: string };
export type ResultLink = { label: string; url: string };
export type ResultAction = { label: string; onPress: () => void };

const c = kivoTheme.colors;

/**
 * A failure message as a short headline plus readable reason; raw program
 * logs ("Simulation details: …") are kept apart for "Copy error details".
 */
export function splitError(message: string): { headline: string; reason?: string; details?: string } {
  const at = message.search(/ ?Simulation details:/);
  const details = at >= 0 ? message : undefined;
  const text = (at >= 0 ? message.slice(0, at) + (/Nothing was sent\.\s*$/.test(message) ? ' Nothing was sent.' : '') : message).replace(/\s*\(\{.*?\}\)/, '').trim();
  if (text.length <= 60) return { headline: text, details };
  return { headline: "Couldn't complete this", reason: text, details };
}
// Success mascot, shown on every successful result. Swap this one file to change it.
const SEASONAL_MASCOT = require('../assets/seasonal-mascot.jpg');

function Logo({ symbol, uri, size }: { symbol: string; uri?: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, borderRadius: size / 2 };
  if (uri && !failed) return <Image source={{ uri }} style={[styles.logo, style]} onError={() => setFailed(true)} />;
  const usd = /^USD/i.test(symbol);
  return <View style={[styles.logo, style, usd && styles.logoUsd]}><Text style={[styles.logoLetter, { fontSize: size * 0.42 }]}>{usd ? '$' : symbol.slice(0, 1).toUpperCase()}</Text></View>;
}

export function ResultCard({
  tone, kicker, headline, subline, hero, from, to, safeNote, reason, steps, rows, links, primary, secondary, tertiary,
}: {
  tone: ResultTone;
  kicker: string;
  headline: string;
  subline?: string;
  hero: { symbol: string; imageUrl?: string | null };
  from?: ResultAsset & { label?: string };
  to?: ResultAsset & { label?: string };
  /** Failure only: whether money moved, shown first. */
  safeNote?: { text: string; ok: boolean };
  reason?: string;
  steps?: { label: string; state: 'done' | 'now' | 'todo' }[];
  rows?: { label: string; value: string }[];
  links?: ResultLink[];
  primary?: ResultAction;
  secondary?: ResultAction;
  tertiary?: ResultAction;
}) {
  const pop = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(0)).current;
  // The mascot is the hero on every result: success, pending and failure.
  const festive = true;

  useEffect(() => {
    pop.setValue(0); rise.setValue(0);
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, delay: 150, useNativeDriver: true }).start();
    Animated.timing(rise, { toValue: 1, duration: 380, delay: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loops: Animated.CompositeAnimation[] = [];
    if (tone === 'success') {
      const l = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }), { iterations: 3 });
      l.start(); loops.push(l);
    }
    if (tone === 'error') {
      shake.setValue(0);
      Animated.sequence([-8, 8, -5, 5, 0].map(v => Animated.timing(shake, { toValue: v, duration: 70, useNativeDriver: true }))).start();
    }
    if (tone === 'pending') {
      const l = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
      l.start(); loops.push(l);
    }
    return () => loops.forEach(l => l.stop());
  }, [tone, pop, ring, shake, spin, rise]);

  const riseStyle = { opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] };
  const tint = tone === 'success' ? 'rgba(169,232,139,0.10)' : tone === 'error' ? 'rgba(255,125,125,0.10)' : 'rgba(244,240,199,0.06)';

  return (
    <View style={styles.wrap}>
      <View style={[styles.glow, { backgroundColor: tint }]} />
      <View style={styles.hero}>
        {tone === 'success' ? <Animated.View style={[styles.ring, { opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.35] }) }] }]} /> : null}
        {tone === 'pending' ? <Animated.View style={[styles.spinner, { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]} /> : null}
        <Animated.View style={[{ transform: [{ translateX: shake }] }]}>
          {festive ? <Image source={SEASONAL_MASCOT} style={styles.mascot} /> : <Logo symbol={hero.symbol} uri={hero.imageUrl} size={92} />}
        </Animated.View>
        {tone !== 'pending' ? (
          <Animated.View style={[styles.badge, tone === 'success' ? styles.badgeOk : styles.badgeBad, { transform: [{ scale: pop }] }]}>
            <Text style={styles.badgeText}>{tone === 'success' ? '✓' : '✕'}</Text>
          </Animated.View>
        ) : null}
      </View>

      <Animated.View style={riseStyle}>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text style={[styles.headline, tone === 'success' && styles.headlineOk, tone !== 'success' && styles.headlinePlain]} numberOfLines={2} adjustsFontSizeToFit>{headline}</Text>
        {subline ? <Text style={styles.subline}>{subline}</Text> : null}

        {safeNote ? <View style={[styles.note, safeNote.ok ? styles.noteSafe : styles.noteWait]}><Text style={[styles.noteText, { color: safeNote.ok ? c.success : c.cream }]}>{safeNote.ok ? '✓ ' : ''}{safeNote.text}</Text></View> : null}
        {reason ? <View style={[styles.note, styles.noteWhy]}><Text style={[styles.noteText, styles.noteWhyText]}>{reason}</Text></View> : null}

        {from && to ? (
          <View style={styles.strip}>
            <View style={styles.leg}><Text style={styles.legLabel}>{from.label ?? 'You paid'}</Text><View style={styles.legRow}><Logo symbol={from.symbol} uri={from.imageUrl} size={20} /><Text style={styles.legValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{from.amount}</Text></View></View>
            <View style={styles.arrow}><Text style={styles.arrowText}>→</Text></View>
            <View style={[styles.leg, styles.legRight]}><Text style={styles.legLabel}>{to.label ?? 'You got'}</Text><View style={[styles.legRow, styles.legRowRight]}><Text style={styles.legValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{to.amount}</Text><Logo symbol={to.symbol} uri={to.imageUrl} size={20} /></View></View>
          </View>
        ) : null}

        {steps?.length ? (
          <View style={styles.steps}>
            {steps.map(step => (
              <View key={step.label} style={styles.step}>
                <View style={[styles.stepDot, step.state === 'done' && styles.stepDone, step.state === 'now' && styles.stepNow]}>{step.state === 'done' ? <Text style={styles.stepCheck}>✓</Text> : null}</View>
                <Text style={[styles.stepText, step.state === 'todo' && styles.stepTodo]}>{step.label}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {rows?.length || links?.length ? (
          <View style={styles.meta}>
            {rows?.map(row => <View key={row.label} style={styles.metaRow}><Text style={styles.metaLabel}>{row.label}</Text><Text style={styles.metaValue} numberOfLines={1}>{row.value}</Text></View>)}
            {links?.map(link => (
              <Pressable key={link.url} hitSlop={6} onPress={() => { Linking.openURL(link.url).catch(() => {}); }} style={styles.metaRow}>
                <Text style={styles.metaLabel}>Transaction</Text><Text style={styles.metaLink}>{link.label} ↗</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.actions}>
          {primary && secondary ? (
            <View style={styles.split}>
              <Pressable onPress={primary.onPress} style={[styles.button, styles.primary, styles.flex]}><Text style={styles.primaryText}>{primary.label}</Text></Pressable>
              <Pressable onPress={secondary.onPress} style={[styles.button, styles.secondary, styles.flex]}><Text style={styles.secondaryText}>{secondary.label}</Text></Pressable>
            </View>
          ) : primary ? (
            <Pressable onPress={primary.onPress} style={[styles.button, styles.primary]}><Text style={styles.primaryText}>{primary.label}</Text></Pressable>
          ) : secondary ? (
            <Pressable onPress={secondary.onPress} style={[styles.button, styles.secondary]}><Text style={styles.secondaryText}>{secondary.label}</Text></Pressable>
          ) : null}
          {tertiary ? <Pressable onPress={tertiary.onPress} style={styles.ghost}><Text style={styles.ghostText}>{tertiary.label}</Text></Pressable> : null}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 10 },
  glow: { position: 'absolute', top: -20, left: -20, right: -20, height: 220, borderRadius: 24 },
  hero: { width: 92, height: 92, alignSelf: 'center', marginTop: 8, marginBottom: 16 },
  logo: { backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoUsd: { backgroundColor: '#2775CA' },
  logoLetter: { color: c.cream, fontWeight: '900' },
  dim: { opacity: 0.75 },
  ring: { position: 'absolute', top: -10, left: -10, right: -10, bottom: -10, borderRadius: 56, borderWidth: 2, borderColor: c.success },
  spinner: { position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 54, borderWidth: 3, borderColor: 'rgba(244,240,199,0.12)', borderTopColor: c.accent },
  badge: { position: 'absolute', right: -6, bottom: -6, width: 38, height: 38, borderRadius: 19, borderWidth: 4, borderColor: c.background, alignItems: 'center', justifyContent: 'center' },
  badgeOk: { backgroundColor: c.success },
  badgeBad: { backgroundColor: c.danger },
  badgeText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 17 },
  mascot: { width: 92, height: 92, borderRadius: 46, backgroundColor: c.surfaceRaised },
  kicker: { textAlign: 'center', color: c.textMuted, fontSize: 13, fontWeight: '800' },
  headline: { textAlign: 'center', fontWeight: '900', marginTop: 4, marginBottom: 2 },
  headlineOk: { color: c.success, fontSize: 32 },
  headlinePlain: { color: c.text, fontSize: 23 },
  subline: { textAlign: 'center', color: c.textMuted, fontSize: 13, marginBottom: 14 },
  note: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, marginTop: 10, borderWidth: 1 },
  noteSafe: { backgroundColor: 'rgba(169,232,139,0.10)', borderColor: 'rgba(169,232,139,0.25)' },
  noteWait: { backgroundColor: 'rgba(244,240,199,0.06)', borderColor: c.border },
  noteWhy: { backgroundColor: 'rgba(255,125,125,0.08)', borderColor: 'rgba(255,125,125,0.22)' },
  noteText: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
  noteWhyText: { color: '#FFC2C2' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.backgroundDeep, borderRadius: 18, borderWidth: 1, borderColor: c.border, padding: 12, marginTop: 6 },
  leg: { flex: 1, minWidth: 0 },
  legRight: { alignItems: 'flex-end' },
  legLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legRowRight: { justifyContent: 'flex-end' },
  legValue: { color: c.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  arrow: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  arrowText: { color: c.accent, fontWeight: '900' },
  steps: { gap: 9, marginTop: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  stepDone: { backgroundColor: c.success, borderColor: c.success },
  stepNow: { borderColor: c.accent },
  stepCheck: { color: c.backgroundDeep, fontSize: 11, fontWeight: '900' },
  stepText: { color: c.text, fontSize: 13 },
  stepTodo: { color: c.textMuted },
  meta: { marginTop: 12, borderTopWidth: 1, borderTopColor: c.border },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border, gap: 12 },
  metaLabel: { color: c.textMuted, fontSize: 13 },
  metaValue: { color: c.text, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  metaLink: { color: c.accent, fontSize: 13, fontWeight: '800' },
  actions: { marginTop: 16, gap: 8 },
  split: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  button: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: c.accent },
  primaryText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
  secondary: { backgroundColor: c.surfaceRaised },
  secondaryText: { color: c.cream, fontWeight: '900', fontSize: 15 },
  ghost: { height: 36, alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: c.textMuted, fontSize: 13, fontWeight: '700' },
});
