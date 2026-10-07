export const kivoTheme = {
  colors: {
    background: '#062F2C',
    backgroundDeep: '#032521',
    surface: '#0A3D38',
    surfaceRaised: '#104A43',
    cream: '#F4F0C7',
    creamMuted: '#DCD8AE',
    text: '#F7F5DF',
    textMuted: '#A9BDB6',
    accent: '#B7E27B',
    border: 'rgba(244, 240, 199, 0.12)',
    danger: '#FF7D7D',
    success: '#A9E88B',
  },
  radius: {
    sm: 10,
    md: 16,
    lg: 24,
    pill: 999,
  },
  spacing: {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
} as const;

export type KivoTheme = typeof kivoTheme;
