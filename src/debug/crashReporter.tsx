// Release builds force-close on an uncaught JavaScript error with no message
// ("Kivo closed because this app has a bug"), and testers have no adb. This
// (ported from mango-pro's crashReporter) keeps the error visible instead:
//   - errors while loading the app show a crash screen instead of closing;
//   - errors while rendering are caught by CrashBoundary;
//   - any other fatal error is saved and shown on the next launch.
// Native (Java/Kotlin) crashes are below JavaScript and are not caught here.

import React from 'react';
import { Pressable, ScrollView, Share, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'kivo_last_crash';

type StoredCrash = { message: string; stack: string; isFatal: boolean; at: number };

// Keep fatal JS errors inside the app. React Native's default global handler
// terminates the process after reporting the error, which is exactly the
// "Kivo closed because this app has a bug" behaviour we need to avoid.
let runtimeCrash: StoredCrash | null = null;
const crashListeners = new Set<(crash: StoredCrash) => void>();

export function installCrashReporter(): void {
  const errorUtils = (globalThis as { ErrorUtils?: { setGlobalHandler: (h: (e: Error, isFatal?: boolean) => void) => void; getGlobalHandler?: () => (e: Error, isFatal?: boolean) => void } }).ErrorUtils;
  if (!errorUtils) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    const record: StoredCrash = { message: error?.message ?? String(error), stack: error?.stack ?? '', isFatal: Boolean(isFatal), at: Date.now() };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record)).catch(() => {});
    if (isFatal) {
      runtimeCrash = record;
      crashListeners.forEach(listener => listener(record));
      return;
    }
    previous?.(error, isFatal);
  });
}

export async function readLastCrash(): Promise<StoredCrash | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredCrash) : null;
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  runtimeCrash = null;
  AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

function subscribeToRuntimeCrash(listener: (crash: StoredCrash) => void): () => void {
  crashListeners.add(listener);
  if (runtimeCrash) listener(runtimeCrash);
  return () => crashListeners.delete(listener);
}

export function CrashScreen({ error, onDismiss }: { error: { message?: string; stack?: string }; onDismiss?: () => void }) {
  const text = `${error.message ?? 'Unknown error'}\n\n${error.stack ?? ''}`.trim();
  return (
    <View style={{ flex: 1, backgroundColor: '#032521', padding: 20, paddingTop: 60 }}>
      <Text style={{ color: '#f4f0c7', fontSize: 22, fontWeight: '800', marginBottom: 8 }}>Kivo hit a problem</Text>
      <Text style={{ color: '#9fb9b3', fontSize: 14, marginBottom: 16 }}>Nothing was signed or sent. Share these details with the Kivo team so it can be fixed.</Text>
      <ScrollView style={{ flex: 1, backgroundColor: '#021a17', borderRadius: 12, padding: 12 }}>
        <Text selectable style={{ color: '#f4f0c7', fontFamily: 'monospace', fontSize: 12 }}>{text}</Text>
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Pressable onPress={() => { Share.share({ message: `Kivo crash report:\n${text}` }).catch(() => {}); }} style={{ flex: 1, backgroundColor: '#f4f0c7', borderRadius: 999, padding: 14, alignItems: 'center' }}>
          <Text style={{ color: '#032521', fontWeight: '800' }}>Share details</Text>
        </Pressable>
        {onDismiss ? (
          <Pressable onPress={onDismiss} style={{ flex: 1, borderColor: '#2b5a53', borderWidth: 1, borderRadius: 999, padding: 14, alignItems: 'center' }}>
            <Text style={{ color: '#f4f0c7', fontWeight: '800' }}>Continue</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type BoundaryState = { error: Error | null; lastCrash: StoredCrash | null };

/** Catches render errors, and shows the previous session's fatal error once. */
export class CrashBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, lastCrash: null };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidMount() {
    const unsubscribe = subscribeToRuntimeCrash(error => this.setState({ lastCrash: error }));
    readLastCrash().then(lastCrash => {
      if (lastCrash && !this.state.lastCrash) this.setState({ lastCrash });
    }).catch(() => {});
    this.unsubscribeCrash = unsubscribe;
  }

  componentWillUnmount() {
    this.unsubscribeCrash?.();
  }

  private unsubscribeCrash?: () => void;

  render() {
    if (this.state.error) return <CrashScreen error={this.state.error} onDismiss={() => this.setState({ error: null })} />;
    if (this.state.lastCrash) return <CrashScreen error={this.state.lastCrash} onDismiss={() => { clearLastCrash(); this.setState({ lastCrash: null }); }} />;
    return this.props.children;
  }
}
