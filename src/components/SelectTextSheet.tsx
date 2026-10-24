import React, { useMemo } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { KivoModal } from './KivoModal';
import { kivoAlert } from './KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';

const c = kivoTheme.colors;

// Links, wallet addresses, #tags, $tickers and @mentions, as in chat bubbles and feed posts.
const PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?<![1-9A-HJ-NP-Za-km-z])(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])|#[\p{L}\p{N}_]+|\$[A-Za-z][A-Za-z0-9_]*|@[A-Za-z0-9_]+/gu;

type Kind = 'link' | 'address' | 'hashtag' | 'ticker' | 'mention';
type Part = { text: string; kind?: Kind; value?: string };

/** Splits a message into plain text and the tappable things inside it. Exported for tests. */
export function splitSelectableText(text: string): Part[] {
  const parts: Part[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (raw.startsWith('@') && start > 0 && /[\w.]/.test(text[start - 1])) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    if (raw.startsWith('@')) parts.push({ text: raw, kind: 'mention', value: raw.slice(1) });
    else if (raw.startsWith('#')) parts.push({ text: raw, kind: 'hashtag', value: 'https://x.com/hashtag/' + encodeURIComponent(raw.slice(1)) });
    else if (raw.startsWith('$')) parts.push({ text: raw, kind: 'ticker', value: 'https://dexscreener.com/search?q=' + encodeURIComponent(raw.slice(1)) });
    else if (/^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(raw)) parts.push({ text: raw, kind: 'address', value: raw });
    else {
      const clean = raw.replace(/[),.!?;:]+$/, '');
      parts.push({ text: clean, kind: 'link', value: clean.startsWith('www.') ? 'https://' + clean : clean });
      const tail = raw.slice(clean.length);
      if (tail) parts.push({ text: tail });
    }
    cursor = start + raw.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function shortValue(part: Part): string {
  if (part.kind === 'address') return part.text.startsWith('0x') ? `${part.text.slice(0, 6)}…${part.text.slice(-4)}` : `${part.text.slice(0, 4)}…${part.text.slice(-4)}`;
  return part.text.length > 42 ? part.text.slice(0, 40) + '…' : part.text;
}

/**
 * "Select text" for a chat message or post. The text is a native selectable
 * Text with no touch handlers on it or around it, so Android's long-press
 * selection works: drag the handles to pick part of the message, then Copy.
 * Links, mentions and addresses stay usable as buttons underneath.
 */
export function SelectTextSheet({ visible, text, title = 'Select text', onClose, onMention }: { visible: boolean; text: string; title?: string; onClose: () => void; onMention?: (username: string) => void }) {
  const parts = useMemo(() => splitSelectableText(text), [text]);
  const actions = useMemo(() => {
    const seen = new Set<string>();
    return parts.filter(part => part.kind && part.value && (part.kind !== 'mention' || onMention) && !seen.has(part.kind + part.value) && seen.add(part.kind + part.value)).slice(0, 12);
  }, [parts, onMention]);
  const copyAll = () => { Clipboard.setString(text); kivoAlert('Copied', 'Text copied to clipboard.'); };
  const run = (part: Part) => {
    if (part.kind === 'address') { Clipboard.setString(part.value!); kivoAlert('Address copied', 'Address copied to clipboard.'); return; }
    if (part.kind === 'mention') { onClose(); onMention?.(part.value!); return; }
    Linking.openURL(part.value!).catch(() => kivoAlert('Link', 'Could not open this link.'));
  };
  return (
    <KivoModal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.shade}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}><Text style={styles.closeText}>✕</Text></Pressable>
          </View>
          <Text style={styles.hint}>Long-press a word, drag the handles to choose the part you want, then tap Copy.</Text>
          <ScrollView style={styles.textBox} contentContainerStyle={styles.textBoxContent}>
            <Text selectable selectionColor={c.accent} style={styles.text}>
              {parts.map((part, index) => part.kind
                ? <Text key={index} style={part.kind === 'mention' ? styles.mention : part.kind === 'hashtag' ? styles.hashtag : part.kind === 'ticker' ? styles.ticker : styles.link}>{part.text}</Text>
                : part.text)}
            </Text>
          </ScrollView>
          {actions.length ? (
            <View style={styles.actions}>
              {actions.map(part => (
                <Pressable key={part.kind! + part.value} onPress={() => run(part)} style={styles.chip} accessibilityRole={part.kind === 'address' ? 'button' : 'link'} accessibilityLabel={part.kind === 'address' ? `Copy address ${part.text}` : `Open ${part.text}`}>
                  <Text style={styles.chipText} numberOfLines={1}>{part.kind === 'address' ? '⧉ ' : part.kind === 'mention' ? '' : '↗ '}{shortValue(part)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Pressable onPress={copyAll} style={styles.copyAll} accessibilityRole="button"><Text style={styles.copyAllText}>Copy all text</Text></Pressable>
        </View>
      </View>
    </KivoModal>
  );
}

const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 24, gap: 12, borderWidth: 1, borderColor: c.border, maxHeight: '85%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: c.text, fontSize: 19, fontWeight: '900' },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  closeText: { color: c.textMuted, fontSize: 16, fontWeight: '900' },
  hint: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
  textBox: { flexGrow: 0, flexShrink: 1, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  textBoxContent: { padding: 14 },
  text: { color: c.text, fontSize: 16, lineHeight: 23 },
  link: { color: c.accent, textDecorationLine: 'underline' },
  mention: { color: c.accent, fontWeight: '800' },
  hashtag: { color: '#9BC9FF', textDecorationLine: 'underline' },
  ticker: { color: c.accent, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceRaised },
  chipText: { color: c.accent, fontSize: 13, fontWeight: '700' },
  copyAll: { height: 48, borderRadius: 24, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  copyAllText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
});
