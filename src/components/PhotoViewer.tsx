import React, { useEffect, useState } from 'react';
import { ActivityIndicator, NativeModules, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { KivoModal } from './KivoModal';
import { kivoTheme } from '../theme/kivoTheme';
import { api } from '../state/session';

// Full-screen photo, Telegram style: pinch or double-tap to zoom, drag to pan,
// Save to put it in the gallery (Pictures/Kivo). The photo is fetched with the
// user's own session and shown from memory; the WebView never loads anything
// from the network and runs no JavaScript.

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the photo.')));
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

function viewerHtml(dataUrl: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=8, user-scalable=yes">
<style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100%;object-fit:contain}</style>
</head><body><img src="${dataUrl}" alt=""></body></html>`;
}

async function canWriteGallery(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version >= 29) return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
  return result === PermissionsAndroid.RESULTS.GRANTED;
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
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDataUrl(null); setError(null); setSaveNote(null); setMenuOpen(false);
    if (!uri) return;
    let active = true;
    // A photo still uploading (or failed) is the picker's local file; server photos need the session.
    const load = /^(file|content):/i.test(uri) ? fetch(uri).then(response => response.blob()) : api.fetchMedia(uri);
    load
      .then(blobToDataUrl)
      .then(url => { if (active) setDataUrl(url); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Could not load this photo.'); });
    return () => { active = false; };
  }, [uri]);

  const save = async () => {
    if (!dataUrl || saving) return;
    const native = NativeModules.MediaSaveModule;
    if (!native?.saveImage) { setSaveNote('Saving is not available in this version of the app.'); return; }
    setSaving(true); setSaveNote(null);
    try {
      if (!(await canWriteGallery())) { setSaveNote('Allow storage access to save photos.'); return; }
      const [, mime = 'image/jpeg', base64 = ''] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) ?? [];
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
            <Pressable style={[styles.menuItem, (!dataUrl || saving) && styles.disabled]} disabled={!dataUrl || saving} onPress={() => { setMenuOpen(false); void save(); }}>
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
          {dataUrl ? (
            <WebView
              source={{ html: viewerHtml(dataUrl) }}
              originWhitelist={['about:blank']}
              javaScriptEnabled={false}
              scalesPageToFit
              setBuiltInZoomControls
              setDisplayZoomControls={false}
              onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
              style={styles.web}
            />
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
  web: { flex: 1, width: '100%', backgroundColor: '#000' },
  note: { color: kivoTheme.colors.cream, textAlign: 'center', padding: 14, fontSize: 13 },
  hint: { color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: 12, fontSize: 12 },
});
