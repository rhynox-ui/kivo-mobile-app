import { Vibration } from 'react-native';
import { getSettings } from '../state/settingsStore';

// Short, distinct pulses for moments that matter (a trade landing or
// failing). Respects Settings › Appearance and Haptics.
const PATTERNS = {
  tap: 12,
  success: [0, 18, 70, 28],
  warning: [0, 30, 90, 30],
  error: [0, 45, 80, 45, 80, 45],
} as const;

export function haptic(kind: keyof typeof PATTERNS): void {
  if (!getSettings().haptics) return;
  try {
    const pattern = PATTERNS[kind];
    if (typeof pattern === 'number') Vibration.vibrate(pattern);
    else Vibration.vibrate([...pattern]);
  } catch {
    // Haptics are optional; never let them affect a trade.
  }
}
