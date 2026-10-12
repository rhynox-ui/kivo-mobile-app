import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { updateSettings, useSettings } from '../state/settingsStore';

export function AppearanceHapticsScreen({ onBack }: { onBack: () => void }) {
  const settings = useSettings();
  const c = kivoTheme.colors;

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={[styles.back, { color: c.cream }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: c.text }]}>Appearance and Haptics</Text>
      </View>

      <Text style={[styles.section, { color: c.textMuted }]}>Appearance</Text>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.row}>
          <View style={styles.copy}>
            <Text style={[styles.label, { color: c.text }]}>Theme</Text>
            <Text style={[styles.hint, { color: c.textMuted }]}>Kivo dark theme</Text>
          </View>
          <Text style={[styles.value, { color: c.textMuted }]}>Dark</Text>
        </View>
      </View>

      <Text style={[styles.section, { color: c.textMuted }]}>Haptics</Text>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Pressable
          onPress={() => updateSettings({ haptics: !settings.haptics })}
          style={styles.row}
          accessibilityRole="switch"
          accessibilityState={{ checked: settings.haptics }}>
          <View style={styles.copy}>
            <Text style={[styles.label, { color: c.text }]}>Haptic feedback</Text>
            <Text style={[styles.hint, { color: c.textMuted }]}>Use vibration feedback for supported actions</Text>
          </View>
          <View style={[styles.switch, { backgroundColor: settings.haptics ? c.accent : c.backgroundDeep, borderColor: settings.haptics ? c.accent : c.border }]}>
            <View style={[styles.thumb, { backgroundColor: settings.haptics ? c.backgroundDeep : c.textMuted, alignSelf: settings.haptics ? 'flex-end' : 'flex-start' }]} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 26 },
  back: { fontSize: 38, lineHeight: 42, width: 38 },
  title: { fontSize: 27, fontWeight: '800', flex: 1 },
  section: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginTop: 8 },
  card: { borderWidth: 1, borderRadius: 18, marginBottom: 18, overflow: 'hidden' },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  copy: { flex: 1, paddingRight: 14 },
  label: { fontSize: 16, fontWeight: '700' },
  hint: { fontSize: 12, marginTop: 4 },
  value: { fontSize: 14, fontWeight: '700' },
  switch: { width: 48, height: 28, borderRadius: 14, borderWidth: 1, padding: 2, justifyContent: 'center' },
  thumb: { width: 22, height: 22, borderRadius: 11 },
});
