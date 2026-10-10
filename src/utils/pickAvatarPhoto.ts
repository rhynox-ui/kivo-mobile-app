import { launchImageLibrary } from 'react-native-image-picker';
import { API_LIMITS } from '@kivo/shared/api/types';

export type PickedAvatar = { uri: string; bytes: Blob; type: 'image/jpeg' | 'image/png' | 'image/webp' };

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Same pipeline as the create-community and edit-profile avatar flows: the
 * native picker resizes to API_LIMITS.avatarEdge and re-encodes at moderate
 * quality, then the bytes are read immediately (the picker's temp file can
 * disappear later) and checked against the server's avatar size cap.
 * Returns null when the person cancels; throws a readable Error otherwise.
 */
export async function pickAvatarPhoto(): Promise<PickedAvatar | null> {
  const result = await launchImageLibrary({
    mediaType: 'photo', selectionLimit: 1, maxWidth: API_LIMITS.avatarEdge,
    maxHeight: API_LIMITS.avatarEdge, quality: 0.6, assetRepresentationMode: 'compatible',
  });
  if (result.didCancel) return null;
  if (result.errorCode) throw new Error(result.errorMessage || 'Could not open your photos.');
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new Error('No readable photo was selected. Please try another image.');
  if (asset.type && !(ALLOWED as readonly string[]).includes(asset.type)) throw new Error('Choose a JPG, PNG or WebP photo.');
  let bytes: Blob;
  try { bytes = await (await fetch(asset.uri)).blob(); }
  catch { throw new Error('Kivo could not read that photo. Please select it again from Gallery.'); }
  if (!bytes.size) throw new Error('The selected photo is empty or unreadable. Please choose another.');
  if (bytes.size > API_LIMITS.maxAvatarBytes) throw new Error('This photo is still too large after compression. Choose another photo.');
  const type = asset.type && (ALLOWED as readonly string[]).includes(asset.type) ? asset.type as PickedAvatar['type'] : 'image/jpeg';
  return { uri: asset.uri, bytes, type };
}
