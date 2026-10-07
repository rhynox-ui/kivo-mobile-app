export const MAX_USERNAME_LENGTH = 32;
export const MAX_BIO_LENGTH = 160;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_GROUP_NAME_LENGTH = 80;
export function normalizeUsername(value: string): string { return value.trim().toLowerCase(); }
export function validUsername(value: string): boolean { return /^[a-z0-9_]{3,32}$/.test(normalizeUsername(value)); }
export function validBio(value: string): boolean { return value.trim().length <= MAX_BIO_LENGTH && isControlFreeText(value); }
export function validMessage(value: string): boolean { const n=value.trim(); return n.length > 0 && n.length <= MAX_MESSAGE_LENGTH && isControlFreeText(value); }
export function validGroupName(value: string): boolean { const n=value.trim(); return n.length > 0 && n.length <= MAX_GROUP_NAME_LENGTH && isControlFreeText(value); }
export function normalizeText(value: string): string { return value.normalize('NFC').trim(); }

export function isControlFreeText(value: string): boolean { return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value); }

export const MAX_POST_LENGTH = 2000;
export function validPost(value: string): boolean {
  const text = normalizeText(value);
  return text.length > 0 && text.length <= MAX_POST_LENGTH && isControlFreeText(text);
}
export function validProfileUsername(value: string): boolean {
  return validUsername(value) && isControlFreeText(value);
}
export function validGroupDescription(value: string): boolean {
  return value.trim().length <= 500 && isControlFreeText(value);
}
