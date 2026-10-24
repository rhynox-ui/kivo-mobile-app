// Chat colour themes (Settings → Chat Settings). Only the conversation view
// changes: its background, both bubble colours and the accent used for names
// and links. Everything else keeps Kivo's own colours.

export type ChatTheme = {id: string; name: string; background: string; mine: string; theirs: string; accent: string};

export const CHAT_THEMES: ChatTheme[] = [
  {id: 'kivo', name: 'Kivo', background: '#032521', mine: '#1D6B4C', theirs: '#104A43', accent: '#B7E27B'},
  {id: 'ocean', name: 'Ocean', background: '#0B1A2B', mine: '#2B6CB0', theirs: '#1A2E44', accent: '#63B3ED'},
  {id: 'midnight', name: 'Midnight', background: '#120F24', mine: '#5B3FA8', theirs: '#251E40', accent: '#B794F4'},
  {id: 'sunset', name: 'Sunset', background: '#22140E', mine: '#B4542A', theirs: '#3A2418', accent: '#F6AD55'},
  {id: 'rose', name: 'Rose', background: '#24101A', mine: '#A33A6B', theirs: '#3D1D2D', accent: '#F687B3'},
  {id: 'graphite', name: 'Graphite', background: '#121417', mine: '#3A4250', theirs: '#22262C', accent: '#E2E8F0'},
];

/** Message text sizes offered, in points (15 is the default). */
export const CHAT_TEXT_SIZES = [13, 15, 17, 19] as const;

export function chatThemeById(id: string | undefined): ChatTheme {
  return CHAT_THEMES.find(theme => theme.id === id) ?? CHAT_THEMES[0];
}

/** Line height that keeps a bubble's text and its inline time aligned at any size. */
export function chatLineHeight(size: number): number {
  return Math.round(size * 4 / 3);
}
