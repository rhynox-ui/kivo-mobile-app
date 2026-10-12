import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

// Kivo-styled replacement for React Native's Alert.alert. Same call shape
// (title, message, buttons, options) so callers keep their buttons and
// actions; the dialog is drawn by <KivoAlertHost/> mounted once in App.tsx.

export type KivoAlertButton = {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: (value?: string) => void;
};
export type KivoAlertOptions = { cancelable?: boolean; onDismiss?: () => void };

type Entry = { id: number; title: string; message?: string; buttons: KivoAlertButton[]; options?: KivoAlertOptions };

let nextId = 1;
let queue: Entry[] = [];
const listeners = new Set<(entry: Entry | null) => void>();
const emit = () => listeners.forEach(listener => listener(queue[0] ?? null));

export function kivoAlert(title: string, message?: string, buttons?: KivoAlertButton[], options?: KivoAlertOptions): void {
  queue = [...queue, { id: nextId++, title, message, buttons: buttons?.length ? buttons : [{ text: 'OK' }], options }];
  emit();
}

function close(entry: Entry, button?: KivoAlertButton) {
  queue = queue.filter(item => item.id !== entry.id);
  emit();
  // Run the action after the dialog is gone so it can open another dialog.
  if (button?.onPress) setTimeout(() => button.onPress?.(), 0);
  else if (!button) entry.options?.onDismiss?.();
}

export function KivoAlertHost() {
  const [entry, setEntry] = useState<Entry | null>(queue[0] ?? null);
  useEffect(() => {
    listeners.add(setEntry);
    setEntry(queue[0] ?? null);
    return () => { listeners.delete(setEntry); };
  }, []);
  if (!entry) return null;

  const cancelButton = entry.buttons.find(button => button.style === 'cancel');
  const dismiss = () => {
    if (cancelButton) close(entry, cancelButton);
    else if (entry.options?.cancelable) close(entry);
  };
  // Cancel sits first (left / bottom of the stack), like the platform dialog.
  const ordered = [...entry.buttons.filter(b => b.style === 'cancel'), ...entry.buttons.filter(b => b.style !== 'cancel')];
  const stacked = ordered.length > 2 || ordered.some(button => (button.text ?? '').length > 14);
  const list = stacked ? [...ordered.filter(b => b.style !== 'cancel'), ...ordered.filter(b => b.style === 'cancel')] : ordered;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss} accessibilityLabel="Close dialog">
        <Pressable style={styles.card} onPress={() => undefined} accessibilityRole="alert">
          <Text style={styles.title}>{entry.title}</Text>
          {entry.message ? (
            <ScrollView style={styles.messageScroll} contentContainerStyle={styles.messageContent}>
              <Text style={styles.message}>{entry.message}</Text>
            </ScrollView>
          ) : null}
          <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
            {list.map((button, index) => {
              const primary = button.style !== 'cancel' && button.style !== 'destructive' && (stacked ? index === 0 : index === list.length - 1);
              return (
                <Pressable
                  key={`${button.text ?? 'OK'}-${index}`}
                  onPress={() => close(entry, button)}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.button,
                    !stacked && styles.buttonRow,
                    button.style === 'destructive' ? styles.buttonDanger : primary ? styles.buttonPrimary : styles.buttonQuiet,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.buttonText, button.style === 'destructive' ? styles.buttonTextDanger : primary ? styles.buttonTextPrimary : styles.buttonTextQuiet]} numberOfLines={2}>
                    {button.text ?? 'OK'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(2, 20, 18, 0.72)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, maxHeight: '80%', borderRadius: kivoTheme.radius.lg, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, padding: 22, elevation: 12 },
  title: { color: c.cream, fontSize: 19, fontWeight: '800', marginBottom: 8 },
  messageScroll: { flexGrow: 0 },
  messageContent: { paddingBottom: 2 },
  message: { color: c.textMuted, fontSize: 15, lineHeight: 21 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 20 },
  buttonsStacked: { flexDirection: 'column' },
  button: { minHeight: 46, borderRadius: kivoTheme.radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonRow: { flex: 1 },
  buttonPrimary: { backgroundColor: c.accent },
  buttonQuiet: { backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  buttonDanger: { backgroundColor: 'rgba(255, 125, 125, 0.14)', borderWidth: 1, borderColor: 'rgba(255, 125, 125, 0.45)' },
  pressed: { opacity: 0.8 },
  buttonText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  buttonTextPrimary: { color: c.backgroundDeep },
  buttonTextQuiet: { color: c.cream },
  buttonTextDanger: { color: c.danger },
});
