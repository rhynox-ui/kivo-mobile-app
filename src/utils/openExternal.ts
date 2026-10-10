import {Alert, Linking} from 'react-native';

/**
 * Opens a link that came from outside Kivo (token socials, market pages).
 * Token creators control those URLs, so only https:// is allowed — never
 * intent:, tel:, wallet deep links or other app schemes.
 */
export function openHttpsUrl(url: string | null | undefined): void {
  let parsed: URL | null = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:') {
    Alert.alert('Link not opened', 'Kivo only opens secure https links.');
    return;
  }
  Linking.openURL(parsed.toString()).catch(() => Alert.alert('Link', 'Could not open this link.'));
}
