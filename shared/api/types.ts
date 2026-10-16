// Wire contract between Kivo clients (web + mobile) and the Kivo social API
// (Cloudflare Pages Functions under web/functions/api, backed by D1 + R2).
//
// Storage model: the server is a thin relay + registry. Full chat history
// lives on each user's device; the server keeps profiles, community
// membership/roles and a rolling window of recent messages so devices can
// sync. Text is deflated at rest, photos are recompressed client-side before
// upload and capped server-side.

export const API_LIMITS = {
  /** Server keeps messages this long; devices keep their own history. */
  messageTtlDays: 30,
  /** Per-message length for accounts with an active Blue Star. */
  maxMessageChars: 5_000,
  /** Per-message length for accounts without an active Blue Star. */
  maxMessageCharsUnverified: 200,
  maxUsernameChars: 32,
  maxBioChars: 160,
  maxCommunityNameChars: 48,
  /** Groups/channels one account may own: 1 each without Blue Star, 10 each with it (server enforced). */
  maxOwnedChannels: 10,
  maxOwnedGroups: 10,
  maxOwnedChannelsUnverified: 1,
  maxOwnedGroupsUnverified: 1,
  maxCommunityDescriptionChars: 280,
  /** Upload caps after client-side compression. */
  maxImageBytes: 160 * 1024,
  maxAvatarBytes: 48 * 1024,
  /** Client compression targets. */
  imageMaxEdge: 1280,
  avatarEdge: 256,
  syncPageSize: 200,
} as const;

export type ApiProfile = {
  userId: string;
  address: string;
  username: string | null;
  bio: string;
  avatarUrl: string | null;
  createdAt: number;
};

/** Public social counters. Social signals only — never proof of wallet ownership. */
export type ProfileSocial = {followers: number; following: number; groups: number; channels: number; isFollowing: boolean};
export type PublicCommunityCard = {id: string; kind: 'group' | 'channel'; name: string; memberCount: number; avatarUrl: string | null};

export type CommunityKind = 'group' | 'channel';
export type CommunityRole = 'owner' | 'admin' | 'member';

export type CommunitySettingsInput = {
  name?: string;
  description?: string;
  avatarKey?: string | null;
  visibility?: 'public' | 'private';
  onlyAdminsPost?: boolean;
};

export function isOfficialKivoChannel(id: string): boolean {
  return id === 'ch_671d27c151fefc25c8e5';
}

export type ApiCommunity = {
  id: string;
  kind: CommunityKind;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  ownerId: string;
  avatarUrl: string | null;
  memberCount: number;
  postCount: number;
  lastActivityAt: number;
  createdAt: number;
  /** The caller's role, or null when not a member / not signed in. */
  myRole: CommunityRole | null;
  /** Server-owned verified status; clients cannot modify this field. */
  isVerified?: boolean;
  /** Groups only: true when just the owner and admins can send. Channels always work this way. */
  onlyAdminsPost?: boolean;
  /** Invite code for the join link. Only sent to the owner and admins. */
  inviteCode?: string | null;
};

export type ApiMember = {userId: string; role: CommunityRole; joinedAt: number; profile: ApiProfile | null; restricted?: boolean};
export type ApiBan = {userId: string; bannedAt: number; profile: ApiProfile | null};

export type ApiConversation = {
  id: string;
  kind: 'dm' | CommunityKind;
  title: string;
  avatarUrl: string | null;
  /** For DMs: the other participant. */
  peer: ApiProfile | null;
  myRole: CommunityRole | null;
  /** Groups where only the owner and admins can send. */
  onlyAdminsPost?: boolean;
  /** Server-owned verified status for channel conversations. */
  isVerified?: boolean;
  /** Kivo's permanently verified official channels: kept at the top of the chat list. */
  pinned?: boolean;
  lastSeq: number;
  lastPreview: string;
  lastSenderId: string | null;
  lastActivityAt: number;
};

export type ApiMessage = {
  seq: number;
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  media: {url: string; width: number | null; height: number | null} | null;
  /** Optional token card attachment for group/channel messages. */
  token?: null | {chain: string; address: string; symbol?: string; name?: string; imageUrl?: string | null};
  replyTo: string | null;
  createdAt: number;
  deleted: boolean;
  editedAt?: number | null;
  forwardedFrom?: string | null;
};

export type SyncResponse = {messages: ApiMessage[]; cursor: number; more: boolean};

export type AuthChallenge = {nonce: string; message: string};
export type AuthSession = {token: string; expiresAt: number; profile: ApiProfile};
export type ProfileApprovalChallenge = {nonce: string; message: string};

// ---------------------------------------------------------------------------
// Wallet identity. A Kivo account is the wallet that signed in: an EVM address
// (`kivo:0x…`, lower-cased) or a Solana address (`kivo:sol:<base58>`, whose
// case is significant and must never be changed). Mobile signs in with EVM
// wallets only, but other people on Kivo can be Solana accounts.

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const KIVO_USER_ID = /^kivo:(0x[0-9a-f]{40}|sol:[1-9A-HJ-NP-Za-km-z]{32,44})$/;

export function isEvmAddress(value: unknown): value is string { return typeof value === 'string' && EVM_ADDRESS.test(value); }
export function isSolanaAddress(value: unknown): value is string { return typeof value === 'string' && SOLANA_ADDRESS.test(value); }
export function isKivoUserId(value: unknown): value is string { return typeof value === 'string' && KIVO_USER_ID.test(value); }

/** Canonical form of a wallet address: EVM lower-cased, Solana unchanged. Null when invalid. */
export function normalizeWalletAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (EVM_ADDRESS.test(trimmed)) return trimmed.toLowerCase();
  if (SOLANA_ADDRESS.test(trimmed)) return trimmed;
  return null;
}

export function kivoUserIdForWallet(address: string): string {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) throw new Error('Invalid wallet address.');
  return normalized.startsWith('0x') ? `kivo:${normalized}` : `kivo:sol:${normalized}`;
}

/** The wallet address behind a Kivo user id (`kivo:0x…` or `kivo:sol:…`). */
export function walletAddressOfUserId(userId: string): string {
  return userId.replace(/^kivo:(sol:)?/, '');
}

export function shortWallet(address: string): string {
  return address.startsWith('0x') ? `${address.slice(0, 6)}…${address.slice(-4)}` : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function profileApprovalMessage(address: string, nonce: string, issuedAt: number, origin: string, username: string, bio: string, avatarAction: 'keep' | 'remove' | 'upload', links?: ProfileLinks): string {
  return [
    'Kivo profile update approval.',
    '',
    `Address: ${normalizeWalletAddress(address) ?? address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `URI: ${origin}`,
    `Username: @${username}`,
    `Bio: ${bio}`,
    `Avatar: ${avatarAction}`,
    // Only present when the update includes links, so older clients sign the same text as before.
    ...(links ? [profileLinksApprovalLine(links)] : []),
    '',
    'This signature approves only this Kivo profile update. It cannot move funds or approve blockchain transactions.',
  ].join('\\n');
}

/**
 * Text of the Solana Memo instruction a Blue Star payment must carry (same
 * format as the web app and server). It binds the on-chain transfer to the
 * buying account and subject, so nobody else can claim it.
 */
export function verificationPaymentMemo(buyerUserId: string, subjectType: 'profile' | 'channel', subjectId: string): string {
  return `kivo-blue-star:${buyerUserId}:${subjectType}:${subjectId}`;
}

/**
 * Length of a message as people see it (same rule as the server). Hermes has
 * no Intl.Segmenter, so the fallback counts code points, which can count a
 * multi-part emoji as more than one — slightly stricter, never looser.
 */
export function messageLength(text: string): number {
  const Segmenter = (Intl as unknown as {Segmenter?: new (locale?: string, options?: {granularity: 'grapheme'}) => {segment(input: string): Iterable<unknown>}}).Segmenter;
  if (Segmenter) {
    let count = 0;
    for (const _ of new Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) count++;
    return count;
  }
  return Array.from(text).length;
}

/** Characters one message may hold: 200 without Blue Star, 5,000 with it. */
export function messageCharLimit(verified: boolean): number {
  return verified ? liveLimits.messageChars.verified : liveLimits.messageChars.unverified;
}

// ---------------------------------------------------------------------------
// Live Blue Star rules. The server enforces them on every request and serves
// them at GET /api/limits; the app applies them at start-up so a rule change
// reaches phones without an app update. Built-in values are only a fallback.

export type ClientLimits = {
  version: 1;
  messageChars: {verified: number; unverified: number};
  ownedGroups: {verified: number; unverified: number};
  ownedChannels: {verified: number; unverified: number};
  profileLinksRequireBlueStar: boolean;
};

const BUILT_IN_LIMITS: ClientLimits = {
  version: 1,
  messageChars: {verified: API_LIMITS.maxMessageChars, unverified: API_LIMITS.maxMessageCharsUnverified},
  ownedGroups: {verified: API_LIMITS.maxOwnedGroups, unverified: API_LIMITS.maxOwnedGroupsUnverified},
  ownedChannels: {verified: API_LIMITS.maxOwnedChannels, unverified: API_LIMITS.maxOwnedChannelsUnverified},
  profileLinksRequireBlueStar: true,
};
let liveLimits: ClientLimits = BUILT_IN_LIMITS;

/** Validates a /api/limits payload; null when it is not a sane version-1 answer. */
export function parseClientLimits(value: unknown): ClientLimits | null {
  const v = value as Partial<ClientLimits> | null;
  const pair = (p: unknown, max: number) => {
    const q = p as {verified?: unknown; unverified?: unknown} | null;
    const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
    return q && ok(q.verified) && ok(q.unverified) ? {verified: q.verified as number, unverified: q.unverified as number} : null;
  };
  if (!v || v.version !== 1) return null;
  const messageChars = pair(v.messageChars, 100_000);
  const ownedGroups = pair(v.ownedGroups, 1_000);
  const ownedChannels = pair(v.ownedChannels, 1_000);
  if (!messageChars || !ownedGroups || !ownedChannels) return null;
  return {version: 1, messageChars, ownedGroups, ownedChannels, profileLinksRequireBlueStar: v.profileLinksRequireBlueStar !== false};
}

/** Applies the server's rules (ignored when invalid). Returns whether they were applied. */
export function applyClientLimits(value: unknown): boolean {
  const parsed = parseClientLimits(value);
  if (parsed) liveLimits = parsed;
  return Boolean(parsed);
}

export function currentClientLimits(): ClientLimits {
  return liveLimits;
}

export function dmConversationId(a: string, b: string): string {
  // Solana ids are case-sensitive; only EVM ids are lower-cased.
  const canonical = (id: string) => (id.startsWith('kivo:sol:') ? id : id.toLowerCase());
  const [x, y] = [canonical(a), canonical(b)].sort();
  return `dm_${x.replace(/^kivo:/, '')}_${y.replace(/^kivo:/, '')}`;
}

/** The exact text a wallet signs to sign in. It authorizes nothing on-chain. */
export function signInMessage(address: string, nonce: string, issuedAt: number, origin: string): string {
  return [
    'Kivo wants you to sign in with your wallet.',
    '',
    `Address: ${normalizeWalletAddress(address) ?? address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `URI: ${origin}`,
    '',
    'This signature only proves you control this wallet. It cannot move funds or approve transactions.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Blue Star profile links. Saved and shown only while the owner's Blue Star is
// active. X and Telegram are stored as handles (always opened on their official
// domains); the website must be https.

export type ProfileLinks = {x?: string; telegram?: string; website?: string};
export const PROFILE_LINK_MAX_CHARS = 200;

function cleanHandle(value: unknown, hosts: string[], pattern: RegExp, label: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let handle = value.trim();
  for (const host of hosts) {
    const match = new RegExp(`^(?:https?://)?(?:www\\.)?${host.replace('.', '\\.')}/([^/?#]+)`, 'i').exec(handle);
    if (match) { handle = match[1]; break; }
  }
  handle = handle.replace(/^@/, '');
  if (!pattern.test(handle)) throw new Error(`Enter a valid ${label} username.`);
  return handle;
}

function cleanHttpsUrl(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error(`Enter a valid ${label} link.`); }
  if (url.protocol !== 'https:' || url.username || url.password || !/\.[a-z]{2,}$/i.test(url.hostname) || url.toString().length > PROFILE_LINK_MAX_CHARS) {
    throw new Error(`${label} must be an https:// link.`);
  }
  return url.toString();
}

/** Validates and normalizes profile links (same rules on clients and server). Throws a readable Error. */
export function normalizeProfileLinks(input: unknown): ProfileLinks {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const links: ProfileLinks = {};
  const x = cleanHandle(raw.x, ['x.com', 'twitter.com'], /^[A-Za-z0-9_]{1,15}$/, 'X');
  const telegram = cleanHandle(raw.telegram, ['t.me', 'telegram.me'], /^[A-Za-z][A-Za-z0-9_]{4,31}$/, 'Telegram');
  const website = cleanHttpsUrl(raw.website, 'Website');
  if (website) links.website = website;
  if (x) links.x = x;
  if (telegram) links.telegram = telegram;
  return links;
}

export function hasProfileLinks(links: ProfileLinks | null | undefined): boolean {
  return Boolean(links && (links.x || links.telegram || links.website));
}

/** Where a stored link opens. X/Telegram always go to their official domains. */
export function profileLinkUrl(kind: keyof ProfileLinks, value: string): string {
  if (kind === 'x') return `https://x.com/${encodeURIComponent(value)}`;
  if (kind === 'telegram') return `https://t.me/${encodeURIComponent(value)}`;
  return value;
}

/** One line added to the profile approval message when links are part of the update. */
export function profileLinksApprovalLine(links: ProfileLinks): string {
  return `Links: ${[links.website ? `website ${links.website}` : '', links.x ? `x @${links.x}` : '', links.telegram ? `telegram @${links.telegram}` : ''].filter(Boolean).join(', ') || 'none'}`;
}

/** How many groups or channels an account may own: 1 each without Blue Star, 10 each with it. */
export function ownedCommunityLimit(kind: 'group' | 'channel', verified: boolean): number {
  const limits = kind === 'channel' ? liveLimits.ownedChannels : liveLimits.ownedGroups;
  return verified ? limits.verified : limits.unverified;
}

/** The message shown when an account has reached its group/channel limit. */
export function ownedCommunityLimitMessage(kind: 'group' | 'channel', verified: boolean): string {
  const limit = ownedCommunityLimit(kind, verified);
  const noun = (n: number) => `${n} ${kind}${n === 1 ? '' : 's'}`;
  return verified
    ? `You can own up to ${noun(limit)}. Delete one you own to create another.`
    : `Without Blue Star you can own ${noun(limit)}. Get Blue Star to own up to ${noun(ownedCommunityLimit(kind, true))}, or delete the one you own.`;
}
