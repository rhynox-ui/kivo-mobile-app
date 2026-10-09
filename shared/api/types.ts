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
  maxMessageChars: 4000,
  maxUsernameChars: 32,
  maxBioChars: 160,
  maxCommunityNameChars: 48,
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
};

export type ApiMember = {userId: string; role: CommunityRole; joinedAt: number; profile: ApiProfile | null; restricted?: boolean};

export type ApiConversation = {
  id: string;
  kind: 'dm' | CommunityKind;
  title: string;
  avatarUrl: string | null;
  /** For DMs: the other participant. */
  peer: ApiProfile | null;
  myRole: CommunityRole | null;
  /** Server-owned verified status for channel conversations. */
  isVerified?: boolean;
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

/** Deterministic DM conversation id for two user ids. */
export function profileApprovalMessage(address: string, nonce: string, issuedAt: number, origin: string, username: string, bio: string, avatarAction: 'keep' | 'remove' | 'upload'): string {
  return [
    'Kivo profile update approval.',
    '',
    `Address: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `URI: ${origin}`,
    `Username: @${username}`,
    `Bio: ${bio}`,
    `Avatar: ${avatarAction}`,
    '',
    'This signature approves only this Kivo profile update. It cannot move funds or approve blockchain transactions.',
  ].join('\\n');
}

export function dmConversationId(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `dm_${x.replace(/^kivo:/, '')}_${y.replace(/^kivo:/, '')}`;
}

/** The exact text a wallet signs to sign in. It authorizes nothing on-chain. */
export function signInMessage(address: string, nonce: string, issuedAt: number, origin: string): string {
  return [
    'Kivo wants you to sign in with your wallet.',
    '',
    `Address: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `URI: ${origin}`,
    '',
    'This signature only proves you control this wallet. It cannot move funds or approve transactions.',
  ].join('\n');
}
