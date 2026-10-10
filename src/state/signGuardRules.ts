// Kivo's server asks the device wallet to sign plain-text messages (sign-in
// and profile approvals). Before signing, check the text really is one of
// those Kivo messages for this wallet, so a compromised or spoofed server
// can't get a signature on something else (another site's login, a permit
// text, ...). Signing is EIP-191 personal_sign: never a transaction.

const KIVO_ORIGINS = new Set(['kivo-mobile://app', 'https://kivo-web.pages.dev', 'https://kivotrade.site', 'https://www.kivotrade.site']);
const HEADERS = {
  'sign-in': 'Kivo wants you to sign in with your wallet.',
  'profile': 'Kivo profile update approval.',
} as const;
const FOOTERS = {
  'sign-in': 'This signature only proves you control this wallet. It cannot move funds or approve transactions.',
  'profile': 'This signature approves only this Kivo profile update. It cannot move funds or approve blockchain transactions.',
} as const;
const MAX_AGE_MS = 15 * 60 * 1000;

export type KivoSignKind = keyof typeof HEADERS;

/** Throws unless `message` is a fresh Kivo message of this kind for this wallet. */
export function assertKivoMessage(message: string, kind: KivoSignKind, address: string): void {
  // The server joins lines with a newline (some messages with a literal "\n").
  const lines = message.split(/\r?\n|\\n/);
  const field = (name: string) => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
  const fail = () => { throw new Error('Kivo refused to sign an unexpected message from the server. Nothing was signed.'); };
  if (lines[0] !== HEADERS[kind] || lines[lines.length - 1] !== FOOTERS[kind]) fail();
  if ((field('Address') ?? '').toLowerCase() !== address.toLowerCase()) fail();
  if (!KIVO_ORIGINS.has(field('URI') ?? '')) fail();
  if (!/^[A-Za-z0-9_-]{8,}$/.test(field('Nonce') ?? '')) fail();
  const issued = Date.parse(field('Issued') ?? '');
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) fail();
}

