import {redactDiagnosticText} from './redactDiagnostics';

const STORAGE_KEY = 'kivo_diagnostics_v1';
const MAX_EVENTS = 30;
let storagePromise: Promise<typeof import('@react-native-async-storage/async-storage').default | null> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function getStorage() {
  if (!storagePromise) {
    storagePromise = import('@react-native-async-storage/async-storage')
      .then(module => module.default)
      .catch(() => null);
  }
  return storagePromise;
}

/**
 * Store a bounded, redacted diagnostic for debugging without writing quote
 * payloads, transaction data, stacks, or raw errors to device logs.
 */
export async function recordDiagnosticEvent(context: string, error: unknown): Promise<void> {
  const storage = await getStorage();
  if (!storage) return;

  const rawMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'Unknown error');
  const entry = {
    at: Date.now(),
    context: context.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80),
    message: redactDiagnosticText(rawMessage).slice(0, 500),
  };

  const write = writeQueue.then(async () => {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const previous = raw ? JSON.parse(raw) : [];
      const entries = Array.isArray(previous) ? previous.filter(item => item && typeof item.at === 'number' && typeof item.context === 'string' && typeof item.message === 'string') : [];
      await storage.setItem(STORAGE_KEY, JSON.stringify([...entries, entry].slice(-MAX_EVENTS)));
    } catch {
      // Diagnostics are best-effort and must never change trade behavior.
    }
  });
  writeQueue = write.then(() => undefined, () => undefined);
  await write;
}

export async function readDiagnosticEvents(): Promise<Array<{at: number; context: string; message: string}>> {
  const storage = await getStorage();
  if (!storage) return [];
  try {
    const raw = await storage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.at === 'number' && typeof item.context === 'string' && typeof item.message === 'string')
      .map(item => ({at: item.at, context: item.context, message: redactDiagnosticText(item.message)}))
      .slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}
