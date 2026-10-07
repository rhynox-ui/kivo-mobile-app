import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

/** Real-data line chart drawn with rotated View segments (no native chart dependency). Green when up, red when down. */
export function LineChart({ values, color }: { values: number[]; color?: string }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const up = values[values.length - 1] >= values[0];
  const stroke = color ?? (up ? kivoTheme.colors.success : kivoTheme.colors.danger);
  const pad = 10;
  const point = (i: number) => ({
    x: pad + (i / (values.length - 1)) * (size.width - pad * 2),
    y: pad + (1 - (values[i] - min) / span) * (size.height - pad * 2),
  });
  const last = size.width > 0 ? point(values.length - 1) : null;
  return (
    <View style={StyleSheet.absoluteFill} onLayout={event => setSize(event.nativeEvent.layout)}>
      {size.width > 0 && values.slice(0, -1).map((_, i) => {
        const a = point(i), b = point(i + 1);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        return <View key={i} style={{ position: 'absolute', left: (a.x + b.x) / 2 - length / 2, top: (a.y + b.y) / 2 - 1, width: length, height: 2, backgroundColor: stroke, transform: [{ rotate: `${angle}rad` }] }} />;
      })}
      {last && <View style={{ position: 'absolute', left: last.x - 5, top: last.y - 5, width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', borderWidth: 2, borderColor: stroke }} />}
    </View>
  );
}
