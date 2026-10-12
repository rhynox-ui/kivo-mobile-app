import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, NativeModules, PanResponder, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { KivoModal } from './KivoModal';
import { kivoTheme } from '../theme/kivoTheme';
import { api } from '../state/session';

// Full-screen photo, Telegram style: pinch or double-tap to zoom, drag to pan,
// Save to put it in the gallery (Pictures/Kivo). Shown with the same native
// Image loading as the chat thumbnail; Save downloads the bytes only when asked.

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the photo.')));
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

async function canWriteGallery(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version >= 29) return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

function distance(event: GestureResponderEvent): number {
  const [a, b] = event.nativeEvent.touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/** Pinch to zoom, drag to pan when zoomed, double-tap to zoom in/out. No extra libraries. */
function ZoomableImage({ source, onError }: { source: { uri: string; headers?: Record<string, string> }; onError: () => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scale = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const state = useRef({ scale: 1, x: 0, y: 0, startScale: 1, startX: 0, startY: 0, startDistance: 0, lastTap: 0, moved: false });

  const clamp = (x: number, y: number, s: number) => {
    const maxX = ((s - 1) * size.width) / 2;
    const maxY = ((s - 1) * size.height) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };
  const animateTo = (s: number, x: number, y: number) => {
    Object.assign(state.current, { scale: s, x, y });
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true, friction: 7 }),
      Animated.spring(translate, { toValue: { x, y }, useNativeDriver: true, friction: 7 }),
    ]).start();
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: event => {
      const st = state.current;
      Object.assign(st, { startScale: st.scale, startX: st.x, startY: st.y, moved: false, startDistance: event.nativeEvent.touches.length === 2 ? distance(event) : 0 });
    },
    onPanResponderMove: (event, gesture) => {
      const st = state.current;
      if (Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6) st.moved = true;
      if (event.nativeEvent.touches.length === 2) {
        st.moved = true;
        if (!st.startDistance) { st.startDistance = distance(event); st.startScale = st.scale; return; }
        const next = Math.max(1, Math.min(MAX_ZOOM, (st.startScale * distance(event)) / st.startDistance));
        const pos = clamp(st.x, st.y, next);
        Object.assign(st, { scale: next, x: pos.x, y: pos.y });
        scale.setValue(next);
        translate.setValue(pos);
      } else if (st.scale > 1) {
        const pos = clamp(st.startX + gesture.dx, st.startY + gesture.dy, st.scale);
        Object.assign(st, { x: pos.x, y: pos.y });
        translate.setValue(pos);
      }
    },
    onPanResponderRelease: () => {
      const st = state.current;
      if (!st.moved) {
        const now = Date.now();
        if (now - st.lastTap < 300) {
          st.lastTap = 0;
          if (st.scale > 1) animateTo(1, 0, 0); else animateTo(DOUBLE_TAP_ZOOM, 0, 0);
          return;
        }
        st.lastTap = now;
      }
      if (st.scale <= 1.01) animateTo(1, 0, 0);
    },
    onPanResponderTerminationRequest: () => false,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [size.width, size.height]);

  return (
    <View style={styles.zoomArea} onLayout={e => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })} {...responder.panHandlers}>
      <Animated.View style={[styles.zoomArea, { transform: [{ translateX: translate.x }, { translateY: translate.y }, { scale }] }]}>
        <Image source={source} style={styles.fullImage} resizeMode="contain" onError={onError} accessibilityLabel="Photo" />
      </Animated.View>
    </View>
  );
}

export type PhotoViewerProps = {
  uri: string | null;
  /** Sender shown in the top bar, e.g. "@kivo". */
  title?: string;
  /** e.g. "Sat, 10 Oct at 02:33". */
  subtitle?: string;
  onClose: () => void;
  /** Starts a reply to the photo's message (Telegram's "Reply"). */
  onReply?: () => void;
};

export function PhotoViewer({ uri, title, subtitle, onClose, onReply }: PhotoViewerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setError(null); setSaveNote(null); setMenuOpen(false); }, [uri]);

  // A photo still uploading (or failed) is the picker's local file; server photos need the session.
  const isLocal = Boolean(uri && /^(file|content):/i.test(uri));
  const cleanUri = uri ? (isLocal ? uri : uri.split('?')[0]) : null;
  const source = cleanUri ? (isLocal ? { uri: cleanUri } : { uri: cleanUri, headers: api.mediaHeaders(cleanUri) }) : null;

  const save = async () => {
    if (!cleanUri || saving) return;
    const native = NativeModules.MediaSaveModule;
    if (!native?.saveImage) { setSaveNote('Saving is not available in this version of the app.'); return; }
    setSaving(true); setSaveNote(null);
    try {
      if (!(await canWriteGallery())) { setSaveNote('Allow storage access to save photos.'); return; }
      const blob = isLocal ? await fetch(cleanUri).then(response => response.blob()) : await api.fetchMedia(cleanUri);
      const dataUrl = await blobToDataUrl(blob);
      const [, sniffed = '', base64 = ''] = /^data:([^;,]*)[^,]*,(.*)$/.exec(dataUrl) ?? [];
      const mime = sniffed.startsWith('image/') ? sniffed : 'image/jpeg';
      const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      await native.saveImage(base64, mime, `kivo-${Date.now()}.${extension}`);
      setSaveNote('Saved to Pictures/Kivo ✓');
    } catch (e) {
      setSaveNote(e instanceof Error && e.message ? e.message : 'Could not save the photo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KivoModal visible={Boolean(uri)} animationType="fade" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.bar}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Back to chat" style={styles.iconButton}><Text style={styles.barIcon}>←</Text></Pressable>
          <View style={styles.titleWrap}>
            {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
            {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          <Pressable onPress={() => setMenuOpen(open => !open)} hitSlop={10} accessibilityLabel="Photo options" style={styles.iconButton}><Text style={styles.barIcon}>⋮</Text></Pressable>
        </View>
        {menuOpen ? (
          <View style={styles.menu}>
            <Pressable style={[styles.menuItem, (!cleanUri || saving) && styles.disabled]} disabled={!cleanUri || saving} onPress={() => { setMenuOpen(false); void save(); }}>
              <Text style={styles.menuIcon}>⤓</Text><Text style={styles.menuText}>{saving ? 'Saving…' : 'Save to Gallery'}</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); onClose(); }}>
              <Text style={styles.menuIcon}>◉</Text><Text style={styles.menuText}>Show in chat</Text>
            </Pressable>
            {onReply ? (
              <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); onReply(); onClose(); }}>
                <Text style={styles.menuIcon}>↩</Text><Text style={styles.menuText}>Reply</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={styles.body}>
          {source && !error ? (
            <ZoomableImage key={source.uri} source={source} onError={() => setError('Could not load this photo.')} />
          ) : error ? <Text style={styles.note}>{error}</Text> : <ActivityIndicator color={kivoTheme.colors.cream} />}
        </View>
        {saveNote ? <Text style={styles.note}>{saveNote}</Text> : <Text style={styles.hint}>Pinch or double-tap to zoom</Text>}
      </View>
    </KivoModal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 6, backgroundColor: 'rgba(0,0,0,0.6)' },
  iconButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  barIcon: { color: '#fff', fontSize: 24, fontWeight: '700' },
  titleWrap: { flex: 1 },
  title: { color: '#fff', fontSize: 17, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 1 },
  menu: { position: 'absolute', top: 58, right: 10, zIndex: 10, minWidth: 220, borderRadius: 14, backgroundColor: '#2a2a2a', paddingVertical: 6, elevation: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 18, paddingVertical: 14 },
  menuIcon: { color: '#fff', fontSize: 18, width: 22, textAlign: 'center' },
  menuText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  zoomArea: { flex: 1, width: '100%', alignSelf: 'stretch' },
  fullImage: { width: '100%', height: '100%' },
  note: { color: kivoTheme.colors.cream, textAlign: 'center', padding: 14, fontSize: 13 },
  hint: { color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: 12, fontSize: 12 },
});
