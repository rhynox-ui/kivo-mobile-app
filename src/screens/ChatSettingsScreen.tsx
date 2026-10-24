import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { CHAT_TEXT_SIZES, CHAT_THEMES, chatLineHeight, chatThemeById } from '../theme/chatThemes';
import { updateSettings, useSettings } from '../state/settingsStore';

const SIZE_LABELS: Record<number, string> = { 13: 'Small', 15: 'Default', 17: 'Large', 19: 'Extra large' };

// Settings → Chat Settings: how conversations look. A live preview on top,
// then message text size and the chat colour theme.
export function ChatSettingsScreen({ onBack }: { onBack: () => void }) {
  const settings = useSettings();
  const theme = chatThemeById(settings.chatTheme);
  const size = settings.chatTextSize;
  const text = { fontSize: size, lineHeight: chatLineHeight(size) };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Chat Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.preview, { backgroundColor: theme.background }]}>
          <View style={[styles.bubble, styles.theirs, { backgroundColor: theme.theirs }]}>
            <Text style={[styles.name, { color: theme.accent }]}>kivo</Text>
            <Text style={[styles.bubbleText, text]}>Good morning! 👋 Anyone watching $SOL?</Text>
          </View>
          <View style={[styles.bubble, styles.mine, { backgroundColor: theme.mine }]}>
            <Text style={[styles.bubbleText, text]}>Bought the dip already 📈</Text>
          </View>
        </View>

        <Text style={styles.section}>Message text size</Text>
        <View style={styles.sizes}>
          {CHAT_TEXT_SIZES.map(value => {
            const on = value === size;
            return (
              <Pressable key={value} onPress={() => updateSettings({ chatTextSize: value })} style={[styles.size, on && styles.sizeOn]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={SIZE_LABELS[value]}>
                <Text style={[styles.sizeSample, { fontSize: value }, on && styles.sizeTextOn]}>Aa</Text>
                <Text style={[styles.sizeLabel, on && styles.sizeTextOn]}>{SIZE_LABELS[value]}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>Color theme</Text>
        <View style={styles.themes}>
          {CHAT_THEMES.map(option => {
            const on = option.id === theme.id;
            return (
              <Pressable key={option.id} onPress={() => updateSettings({ chatTheme: option.id })} style={styles.themeCell} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${option.name} theme`}>
                <View style={[styles.tile, { backgroundColor: option.background, borderColor: on ? option.accent : kivoTheme.colors.border }, on && styles.tileOn]}>
                  <View style={[styles.pill, styles.pillTheirs, { backgroundColor: option.theirs }]} />
                  <View style={[styles.pill, styles.pillMine, { backgroundColor: option.mine }]} />
                  <View style={[styles.dot, { backgroundColor: option.accent }]} />
                </View>
                <Text style={[styles.themeName, on && { color: kivoTheme.colors.text }]}>{option.name}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, paddingHorizontal: 20 },
  back: { fontSize: 38, lineHeight: 42, width: 38, color: c.cream },
  title: { fontSize: 27, fontWeight: '800', flex: 1, color: c.text },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  preview: { borderRadius: 18, borderWidth: 1, borderColor: c.border, padding: 12, gap: 8, marginBottom: 18 },
  bubble: { maxWidth: '84%', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16 },
  theirs: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  name: { fontSize: 13, fontWeight: '800', marginBottom: 1 },
  bubbleText: { color: c.text },
  section: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, color: c.textMuted },
  sizes: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  size: { flex: 1, minHeight: 64, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', gap: 2 },
  sizeOn: { borderColor: c.accent, backgroundColor: c.surfaceRaised },
  sizeSample: { color: c.textMuted, fontWeight: '800' },
  sizeLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700' },
  sizeTextOn: { color: c.text },
  themes: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  themeCell: { width: '30%', flexGrow: 1, alignItems: 'center', gap: 6 },
  tile: { width: '100%', aspectRatio: 0.85, borderRadius: 14, borderWidth: 1, padding: 10, justifyContent: 'center', gap: 8 },
  tileOn: { borderWidth: 2.5 },
  pill: { height: 14, borderRadius: 7 },
  pillTheirs: { width: '70%', alignSelf: 'flex-start' },
  pillMine: { width: '60%', alignSelf: 'flex-end' },
  dot: { position: 'absolute', right: 8, top: 8, width: 10, height: 10, borderRadius: 5 },
  themeName: { color: c.textMuted, fontSize: 12, fontWeight: '700' },
});
