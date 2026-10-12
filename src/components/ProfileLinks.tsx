import React from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoAlert } from './KivoAlert';
import { profileLinkUrl, type ProfileLinks } from '@kivo/shared/api/types';
import { kivoTheme } from '../theme/kivoTheme';

// Blue Star links (website, X, Telegram) for profiles, channels and groups.
// The server decides who may have them and only returns them while the Blue
// Star is active; this file only displays and edits them.

const KINDS = ['website', 'x', 'telegram'] as const;
const LABEL: Record<keyof ProfileLinks, string> = { website: 'Website', x: 'X', telegram: 'Telegram' };
const GLYPH: Record<keyof ProfileLinks, string> = { website: '🌐', x: '𝕏', telegram: '✈' };

function linkText(kind: keyof ProfileLinks, value: string): string {
  if (kind !== 'website') return '@' + value;
  return value.replace(/^https:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').slice(0, 32);
}

/** Opens a stored link. Only https URLs built by profileLinkUrl are ever opened. */
function openLink(kind: keyof ProfileLinks, value: string) {
  const url = profileLinkUrl(kind, value);
  if (!/^https:\/\//i.test(url)) { kivoAlert(LABEL[kind], 'This link cannot be opened.'); return; }
  Linking.openURL(url).catch(() => kivoAlert(LABEL[kind], 'Could not open this link.'));
}

export function ProfileLinkChips({ links }: { links: ProfileLinks }) {
  const present = KINDS.filter(kind => links[kind]);
  if (!present.length) return null;
  return (
    <View style={styles.chips}>
      {present.map(kind => (
        <Pressable key={kind} accessibilityRole="link" accessibilityLabel={`${LABEL[kind]}: ${linkText(kind, links[kind]!)} (opens outside Kivo)`} onPress={() => openLink(kind, links[kind]!)} style={styles.chip}>
          <Text style={styles.chipIcon}>{GLYPH[kind]}</Text>
          <Text style={styles.chipText} numberOfLines={1}>{linkText(kind, links[kind]!)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export type LinkDraft = { website: string; x: string; telegram: string };

/** Turns stored links into editable text (handles shown with @). */
export function linkDraftFrom(links: ProfileLinks | null | undefined): LinkDraft {
  return { website: links?.website ?? '', x: links?.x ? '@' + links.x : '', telegram: links?.telegram ? '@' + links.telegram : '' };
}

export function LinkFields({ value, onChange, editable, telegramPlaceholder = '@username' }: { value: LinkDraft; onChange: (next: LinkDraft) => void; editable: boolean; telegramPlaceholder?: string }) {
  const placeholders: Record<keyof LinkDraft, string> = { website: 'yourwebsite.com', x: '@handle', telegram: telegramPlaceholder };
  return (
    <View style={styles.fields}>
      {KINDS.map(kind => (
        <View key={kind} style={[styles.field, !editable && styles.fieldDisabled]}>
          <Text style={styles.fieldIcon}>{GLYPH[kind]}</Text>
          <TextInput
            value={value[kind]}
            onChangeText={text => onChange({ ...value, [kind]: text })}
            editable={editable}
            placeholder={placeholders[kind]}
            placeholderTextColor={kivoTheme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={kind === 'website' ? 'url' : 'default'}
            accessibilityLabel={kind === 'website' ? 'Website' : `${LABEL[kind]} username`}
            style={styles.fieldInput}
          />
        </View>
      ))}
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 220, borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: c.surfaceRaised },
  chipIcon: { color: c.cream, fontSize: 13 },
  chipText: { color: c.text, fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
  fields: { gap: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, backgroundColor: c.backgroundDeep },
  fieldDisabled: { opacity: 0.55 },
  fieldIcon: { color: c.cream, fontSize: 14, width: 18, textAlign: 'center' },
  fieldInput: { flex: 1, paddingVertical: 10, color: c.text, fontSize: 14 },
});
