// Typed client for the Kivo social API, shared by web and mobile.
import type {KeyValueStorage} from '../storage';
import type {ProfileSocial, PublicCommunityCard} from './types';
import type {ChatPollPayload, ChatPollResults, FeedPoll, PollSettingsWithDuration} from '../polls/types';
import type {ApiBan, CallStats, CommunityGate, GateCheck, ApiCommunity, ApiConversation, ApiMember, ApiMessage, ApiProfile, AuthChallenge, AuthSession, CommunityKind, CommunitySettingsInput, ProfileApprovalChallenge, ProfileLinks, SyncResponse} from './types';

export type WatchlistToken = {chainKey: string; tokenAddress: string; symbol: string; name: string; imageUrl: string | null; savedAt: number};
import {kivoUserIdForWallet, normalizeWalletAddress} from './types';

export type FeedPost = {
  id: string; userId: string; username: string; avatarUrl: string | null; body: string; imageUrl: string | null; createdAt: number;
  token: null | {chain: string; address: string; symbol: string; name: string; imageUrl: string | null; entryMarketCapUsd: number | null};
  likeCount: number; dislikeCount: number; replyCount: number; likedByViewer: boolean; dislikedByViewer: boolean; pinned: boolean; pollId?: string | null; nextCursor?: string;
};
export type FeedReply = {id: string; postId: string; userId: string; username: string; avatarUrl: string | null; body: string; createdAt: number};
export type FeedPostNotification = {id: string; kind: 'post' | 'like' | 'dislike' | 'reply'; postId: string; actorId: string; actorUsername: string; postPreview: string; createdAt: number; readAt: number | null};

export type ReferralUser = {userId: string; username: string | null; avatarUrl: string | null; verified: boolean};
export type ReferralSource = 'install' | 'manual';
export type ReferralsMe = {
  /** Null until the account has published a username; then there is no referral link either. */
  username: string | null; link: string | null; feeBps: number; referredBy: ReferralUser | null; canSetReferrer: boolean;
  referralCount: number; tradedCount: number; clickCount?: number; totalEarnedUsd: number; thisWeekUsd: number; pendingUsd: number; paidUsd: number;
  referrals: (ReferralUser & {joinedAt: number; feesUsd: number; earnedUsd: number})[];
  recentRewards: {referredUsername: string | null; referredUserId?: string | null; referredAvatarUrl: string | null; feeUsd: number; rewardUsd: number; chain: string; txHash?: string | null; createdAt: number}[];
  payouts: {amountUsd: number; chain: string; txHash: string; createdAt: number}[];
};
/** `retry`: the server could not check the trade yet (not indexed, price unavailable); report it again later. */
export type ReferralTradeResult = {recorded: boolean; rewardUsd?: number; needsSolanaLink?: boolean; retry?: boolean; error?: string};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type KivoApiOptions = {baseUrl: string; storage: KeyValueStorage; sessionStorage?: KeyValueStorage; client: 'web' | 'mobile'};
const SESSION_KEY = 'kivo:api-session:v1';
const VERIFICATION_TTL_MS = 60_000;
export type VerificationStatus = {isVerified: boolean; permanent: boolean; expiresAt: number | null; plan: 'monthly' | 'annual' | null; chain?: string};

export class KivoApi {
  private baseUrl: string;
  private storage: KeyValueStorage;
  private sessionStorage: KeyValueStorage;
  private client: 'web' | 'mobile';
  private session: {token: string; expiresAt: number; address: string} | null = null;
  private sessionGeneration = 0;
  private verificationCache = new Map<string, {at: number; value: VerificationStatus}>();
  private verificationInFlight = new Map<string, Promise<VerificationStatus>>();
  private activeAddress: string | null = null;
  private sessionWriteQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(options: KivoApiOptions) { this.baseUrl = options.baseUrl.replace(/\/$/, ''); this.storage = options.storage; this.sessionStorage = options.sessionStorage ?? options.storage; this.client = options.client; }
  private async writeSessionStorage(generation: number, value: string | null): Promise<boolean> {
    const operation = this.sessionWriteQueue.then(async () => {
      if (generation !== this.sessionGeneration) return false;
      if (value === null) {
        await this.sessionStorage.removeItem?.(SESSION_KEY);
      } else {
        await this.sessionStorage.setItem(SESSION_KEY, value);
        // Storage writes cannot be cancelled. If the wallet changed while
        // setItem was pending, remove the stale value before the next queued
        // write/restore is allowed to proceed.
        if (generation !== this.sessionGeneration) {
          await this.sessionStorage.removeItem?.(SESSION_KEY);
          return false;
        }
      }
      return generation === this.sessionGeneration;
    });
    this.sessionWriteQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  onSessionChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.listeners.forEach(listener => listener()); }

  async restore(address: string | null): Promise<boolean> {
    const generation = ++this.sessionGeneration;
    const normalizedAddress = address ? normalizeWalletAddress(address) : null;
    this.activeAddress = normalizedAddress;
    this.session = null;
    this.emit();
    if (!normalizedAddress) return false;
    try {
      await this.sessionWriteQueue;
      if (generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) return false;
      const raw = await this.sessionStorage.getItem(SESSION_KEY);
      const saved = raw ? JSON.parse(raw) as {token: string; expiresAt: number; address: string} : null;
      if (generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) return false;
      if (saved && saved.address === normalizedAddress && saved.expiresAt > Date.now() + 60_000 && /^kv_[0-9a-f]{64}$/.test(saved.token)) this.session = saved;
    } catch {}
    if (generation === this.sessionGeneration) this.emit();
    return generation === this.sessionGeneration && Boolean(this.session);
  }

  /** The server account id of the current session (`kivo:<wallet>`), or null when signed out. */
  signedInUserId(): string | null { return this.session && this.session.expiresAt > Date.now() ? kivoUserIdForWallet(this.session.address) : null; }
  isSignedIn(address?: string | null): boolean { return Boolean(this.session && this.session.expiresAt > Date.now() && (!address || this.session.address === normalizeWalletAddress(address))); }

  /** Auth headers for same-origin media only; never attach the session to local or foreign URLs. */
  mediaHeaders(url?: string): Record<string, string> {
    if (!this.session || this.session.expiresAt <= Date.now()) return {};
    if (url) {
      try {
        const base = new URL(this.baseUrl || 'https://kivo-web.pages.dev');
        const target = new URL(url, base);
        if (target.origin !== base.origin || !target.pathname.startsWith('/api/media/')) return {};
      } catch { return {}; }
    }
    return {authorization: `Bearer ${this.session.token}`};
  }

  /** Fetch private media with the current session; never send a bearer token off-origin. */
  async fetchMedia(url: string): Promise<Blob> {
    const base = new URL(this.baseUrl || 'https://kivo-web.pages.dev');
    const target = new URL(url, base);
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/media/')) {
      throw new ApiError(400, 'Invalid media URL.');
    }
    // Older cached messages may still contain signed query parameters. They are
    // not credentials anymore; rebuild the URL from origin + path so they never
    // reach the request or logs, without mutating runtime URL implementations.
    const safeTarget = new URL(target.origin + target.pathname);
    const response = await fetch(safeTarget.toString(), {headers: this.mediaHeaders(safeTarget.toString())});
    if (!response.ok) throw new ApiError(response.status, response.status === 403 ? 'You no longer have access to this photo.' : 'Could not load this photo.');
    return response.blob();
  }

  async signIn(address: string, sign: (message: string) => Promise<string>): Promise<AuthSession> {
    const generation = ++this.sessionGeneration;
    const normalizedAddress = normalizeWalletAddress(address);
    if (!normalizedAddress) throw new ApiError(400, 'Invalid wallet address.');
    this.activeAddress = normalizedAddress;
    const challenge = await this.request<AuthChallenge>('POST', '/api/auth/challenge', {address, client: this.client}, false);
    if (generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) throw new ApiError(409, 'Wallet changed during sign-in. Please try again.');
    const signature = await sign(challenge.message);
    if (generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) throw new ApiError(409, 'Wallet changed during sign-in. Please try again.');
    const session = await this.request<AuthSession>('POST', '/api/auth/verify', {address, nonce: challenge.nonce, signature}, false);
    if (generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) throw new ApiError(409, 'Wallet changed during sign-in. Please try again.');
    const nextSession = {token: session.token, expiresAt: session.expiresAt, address: normalizedAddress};
    const persisted = await this.writeSessionStorage(generation, JSON.stringify(nextSession));
    if (!persisted || generation !== this.sessionGeneration || this.activeAddress !== normalizedAddress) throw new ApiError(409, 'Wallet changed during sign-in. Please try again.');
    this.session = nextSession;
    this.emit();
    return session;
  }

  async signOut() {
    const sessionAtSignOut = this.session;
    const generation = ++this.sessionGeneration;
    if (sessionAtSignOut) await this.request('POST', '/api/auth/signout', {}).catch(() => {});
    // A wallet switch or newer sign-in while sign-out was in flight owns the
    // new session; never clear it as a side effect of this older operation.
    if (generation !== this.sessionGeneration || this.session?.token !== sessionAtSignOut?.token) return;
    this.session = null;
    await this.writeSessionStorage(generation, null);
    if (generation === this.sessionGeneration) this.emit();
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true, raw?: {body: Blob | ArrayBuffer | Uint8Array; type: string}): Promise<T> {
    const headers: Record<string, string> = {};
    // Bind this request to the session it started with. A late 401 from an
    // old wallet/session must not clear a newer session after account switching.
    const sessionAtRequest = auth ? this.session : null;
    if (sessionAtRequest) headers.authorization = `Bearer ${sessionAtRequest.token}`;
    let payload: RequestInit['body'] | undefined;
    if (raw) { headers['content-type'] = raw.type; payload = raw.body as RequestInit['body']; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let response: Response;
    // A hung request (e.g. on a network switch) must not freeze chat sync,
    // which skips every poll while one is in flight.
    const timeoutMs = raw ? 120_000 : method === 'GET' ? 15_000 : 30_000;
    const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as {timeout?: unknown}).timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    try { response = await fetch(this.baseUrl + path, {method, headers, body: payload, signal}); }
    catch { throw new ApiError(0, 'You appear to be offline. Kivo will retry when you are back.'); }
    const data = await response.json().catch(() => null) as (T & {error?: string}) | null;
    if (!response.ok) {
      if (response.status === 401 && sessionAtRequest && this.session?.token === sessionAtRequest.token) {
        const generation = ++this.sessionGeneration;
        this.session = null;
        void this.writeSessionStorage(generation, null).then(() => { if (generation === this.sessionGeneration) this.emit(); });
      }
      throw new ApiError(response.status, data?.error ?? `Request failed (${response.status}).`);
    }
    return data as T;
  }

  me() { return this.request<ApiProfile>('GET', '/api/me'); }
  watchlist() { return this.request<WatchlistToken[]>('GET', '/api/watchlist'); }
  saveWatchlistToken(token: Pick<WatchlistToken, 'chainKey' | 'tokenAddress' | 'symbol' | 'name' | 'imageUrl'>) { return this.request<{token: WatchlistToken}>('PUT', '/api/watchlist', token); }
  removeWatchlistToken(chainKey: string, tokenAddress: string) { return this.request<{removed: boolean}>('DELETE', `/api/watchlist?chain=${encodeURIComponent(chainKey)}&address=${encodeURIComponent(tokenAddress)}`); }
  requestProfileApproval(input: {username: string; bio: string; avatarAction: 'keep' | 'remove' | 'upload'; links?: ProfileLinks}) {
    return this.request<ProfileApprovalChallenge>('POST', '/api/profile/approval-challenge', input);
  }
  updateProfile(input: {username: string; bio: string; avatarKey?: string | null; approvalNonce: string; approvalSignature: string; approvalAvatarAction: 'keep' | 'remove' | 'upload'; links?: ProfileLinks}) {
    return this.request<ApiProfile>('PUT', '/api/profile', input);
  }
  searchProfiles(q: string) { return this.request<ApiProfile[]>('GET', `/api/profiles?q=${encodeURIComponent(q)}`, undefined, false); }
  profiles(ids: string[]) { return ids.length ? this.request<ApiProfile[]>('GET', `/api/profiles?ids=${encodeURIComponent(ids.slice(0, 100).join(','))}`, undefined, false) : Promise.resolve([]); }
  profileLinks(userId: string) { return this.request<{verified: boolean; links: ProfileLinks}>('GET', `/api/profiles/${encodeURIComponent(userId)}/links`, undefined, false); }
  social(userId: string) { return this.request<ProfileSocial>('GET', `/api/profiles/${encodeURIComponent(userId)}/social`); }
  publicCommunitiesOf(userId: string) { return this.request<PublicCommunityCard[]>('GET', `/api/profiles/${encodeURIComponent(userId)}/communities`, undefined, false); }
  follow(userId: string) { return this.request<ProfileSocial>('POST', `/api/follows/${encodeURIComponent(userId)}`, {}); }
  unfollow(userId: string) { return this.request<ProfileSocial>('DELETE', `/api/follows/${encodeURIComponent(userId)}`); }
  uploadImage(bytes: Blob | ArrayBuffer | Uint8Array, type: string, kind: 'avatar' | 'message') {
    return this.request<{key: string; url: string; bytes: number}>('POST', `/api/media?kind=${kind}`, undefined, true, {body: bytes, type});
  }
  discover(kind?: CommunityKind, q = '') { return this.request<ApiCommunity[]>('GET', `/api/communities?${kind ? `kind=${kind}&` : ''}q=${encodeURIComponent(q)}`); }
  myCommunities() { return this.request<ApiCommunity[]>('GET', '/api/communities/mine'); }
  community(id: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('GET', `/api/communities/${encodeURIComponent(id)}`); }
  createCommunity(input: {kind: CommunityKind; name: string; description: string; visibility: 'public' | 'private'; avatarKey?: string | null}) { return this.request<ApiCommunity>('POST', '/api/communities', input); }
  join(id: string, inviteCode?: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('POST', `/api/communities/${encodeURIComponent(id)}/join`, inviteCode ? {inviteCode} : {}); }
  updateCommunity(id: string, input: CommunitySettingsInput) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('PATCH', `/api/communities/${encodeURIComponent(id)}`, input); }
  deleteCommunity(id: string) { return this.request<{ok: true}>('DELETE', `/api/communities/${encodeURIComponent(id)}`); }
  resetInvite(id: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('POST', `/api/communities/${encodeURIComponent(id)}/invite`, {}); }
  invite(code: string) { return this.request<ApiCommunity>('GET', `/api/communities/invite/${encodeURIComponent(code)}`); }
  leave(id: string) { return this.request<{ok: true}>('POST', `/api/communities/${encodeURIComponent(id)}/leave`, {}); }
  addMember(id: string, address: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('POST', `/api/communities/${encodeURIComponent(id)}/members`, {address}); }
  removeMember(id: string, userId: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>( 'DELETE', `/api/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`); }
  communityLinks(id: string) { return this.request<{eligible: boolean; links: ProfileLinks}>('GET', `/api/communities/${encodeURIComponent(id)}/links`); }
  saveCommunityLinks(id: string, links: ProfileLinks) { return this.request<{eligible: boolean; links: ProfileLinks}>('PUT', `/api/communities/${encodeURIComponent(id)}/links`, {links}); }
  bans(id: string) { return this.request<ApiBan[]>('GET', `/api/communities/${encodeURIComponent(id)}/bans`); }
  setBanned(id: string, userId: string, banned: boolean) { return this.request<{community: ApiCommunity; members: ApiMember[]}>(banned ? 'POST' : 'DELETE', `/api/communities/${encodeURIComponent(id)}/bans/${encodeURIComponent(userId)}`, banned ? {} : undefined); }
  setAdmin(id: string, userId: string, promote: boolean) { return this.request<{community: ApiCommunity; members: ApiMember[]}>(promote ? 'POST' : 'DELETE', `/api/communities/${encodeURIComponent(id)}/admins/${encodeURIComponent(userId)}`, promote ? {} : undefined); }
  latestVerificationReceipt(subjectType: 'profile' | 'channel', subjectId: string) {
    return this.request<{
      id: string; subject_type: 'profile' | 'channel'; subject_id: string; plan: 'monthly' | 'annual';
      chain: 'ethereum' | 'base' | 'arbitrum' | 'solana'; amount: number; txHash: string; payer: string;
      recipient: string; paidAt: number; expiresAt: number; explorerUrl: string; status: string;
    } | null>('GET', `/api/verification/receipt?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`);
  }
  /**
   * Blue Star status, shared by every screen. A confirmed answer is reused for
   * up to a minute (so a busy group doesn't ask once per sender, and an
   * expired Blue Star still disappears within a minute); concurrent asks share
   * one request; failures are never cached.
   */
  verificationStatus(subjectType: 'profile' | 'channel', subjectId: string): Promise<VerificationStatus> {
    const key = `${subjectType}:${subjectId}`;
    const hit = this.verificationCache.get(key);
    if (hit && Date.now() - hit.at < VERIFICATION_TTL_MS) return Promise.resolve(hit.value);
    const pending = this.verificationInFlight.get(key);
    if (pending) return pending;
    const promise = this.request<VerificationStatus>('GET', `/api/verification/status?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`)
      .then(value => { this.verificationCache.set(key, {at: Date.now(), value}); return value; })
      .finally(() => { this.verificationInFlight.delete(key); });
    this.verificationInFlight.set(key, promise);
    return promise;
  }
  /** Drop a cached Blue Star answer (after buying or renewing one). */
  forgetVerification(subjectType: 'profile' | 'channel', subjectId: string): void {
    this.verificationCache.delete(`${subjectType}:${subjectId}`);
  }
  /** The Blue Star rules the server currently enforces (public, no session needed). */
  limits() { return this.request<unknown>('GET', '/api/limits', undefined, false); }
  purchaseVerification(input: {subjectType: 'profile' | 'channel'; subjectId: string; plan: 'monthly' | 'annual'; chain: 'ethereum' | 'base' | 'arbitrum' | 'solana'; txHash: string}) {
    return this.request<{id: string; plan: string; chain: string; token: 'USDC'; amount: string; txHash: string; payer: string; recipient: string; paidAt: number; expiresAt: number; explorerUrl: string; blockNumber: number; status: string}>('POST', '/api/verification/purchase', input);
  }
  accountDeletionStatus() { return this.request<{pending: boolean; status: 'pending' | 'processing' | null; requestedAt: number | null; executeAt: number | null}>('GET', '/api/account-deletion'); }
  requestAccountDeletion() { return this.request<{pending: true; status: 'pending'; requestedAt: number; executeAt: number}>('POST', '/api/account-deletion', {}); }
  cancelAccountDeletion() { return this.request<{pending: false; cancelled: true}>('DELETE', '/api/account-deletion'); }
  moderationStatus() { return this.request<{cooldownUntil: number; reason: string}>('GET', '/api/moderation/status'); }
  feedPosts(cursor?: string, following = false) { const params = new URLSearchParams(); if (cursor) params.set('cursor', cursor); if (following) params.set('following', '1'); const query = params.toString(); return this.request<FeedPost[]>('GET', `/api/feed${query ? `?${query}` : ''}`); }
  createFeedPost(input: {body: string; imageKey?: string | null; token?: {chain: string; address: string} | null}) { return this.request<FeedPost>('POST', '/api/feed', input); }
  createFeedPoll(input: {question: string; description?: string; options: string[]; settings?: Partial<PollSettingsWithDuration>}) { return this.request<FeedPost>('POST', '/api/feed/polls', input); }
  feedPoll(postId: string) { return this.request<FeedPoll>('GET', `/api/feed/${encodeURIComponent(postId)}/poll`); }
  voteFeedPoll(postId: string, optionIds: string[]) { return this.request<FeedPoll>('POST', `/api/feed/${encodeURIComponent(postId)}/poll/vote`, {optionIds}); }
  addFeedPollOption(postId: string, label: string) { return this.request<FeedPoll>('POST', `/api/feed/${encodeURIComponent(postId)}/poll/options`, {label}); }
  setFeedReaction(postId: string, reaction: 'like' | 'dislike' | null) { return this.request<{reaction: 'like' | 'dislike' | null; likeCount: number; dislikeCount: number}>('POST', `/api/feed/${encodeURIComponent(postId)}/reaction`, {reaction}); }
  deleteFeedPost(postId: string) { return this.request<{deleted: true}>('DELETE', `/api/feed/${encodeURIComponent(postId)}`); }
  /** Posts the viewer scrolled past, so For You shows new ones first. */
  markFeedSeen(postIds: string[]) { return this.request<{seen: number}>('POST', '/api/feed/seen', {postIds}); }
  /** Tokens the viewer's wallet holds (public on-chain data), so posts about them rank higher. */
  setFeedHoldings(tokens: {chain: string; address: string}[]) { return this.request<{tokens: number}>('PUT', '/api/feed/holdings', {tokens}); }
  setFeedPostPinned(postId: string, pinned: boolean) { return this.request<{pinned: boolean}>('POST', `/api/feed/${encodeURIComponent(postId)}/pin`, {pinned}); }
  feedReplies(postId: string) { return this.request<FeedReply[]>('GET', `/api/feed/${encodeURIComponent(postId)}/replies`, undefined, false); }
  createFeedReply(postId: string, body: string) { return this.request<FeedReply>('POST', `/api/feed/${encodeURIComponent(postId)}/replies`, {body}); }
  feedNotifications() { return this.request<FeedPostNotification[]>('GET', '/api/feed/notifications'); }
  markFeedNotificationsRead() { return this.request<{updated: boolean}>('POST', '/api/feed/notifications/read', {}); }
  feedPostNotificationSubscription(authorId: string) { return this.request<{enabled: boolean}>('GET', `/api/feed/notifications/${encodeURIComponent(authorId)}`); }
  setFeedPostNotificationSubscription(authorId: string, enabled: boolean) { return this.request<{enabled: boolean}>('POST', `/api/feed/notifications/${encodeURIComponent(authorId)}`, {enabled}); }
  conversations() { return this.request<ApiConversation[]>('GET', '/api/conversations'); }
  openDm(address: string) { return this.request<{id: string}>('POST', '/api/conversations/dm', {address}); }
  history(conversationId: string, before?: number) { return this.request<ApiMessage[]>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/messages${before ? `?before=${before}` : ''}`); }
  send(conversationId: string, input: {text: string; mediaKey?: string; mediaWidth?: number; mediaHeight?: number; token?: {chain: string; address: string}; poll?: ChatPollPayload; replyTo?: string; clientId: string}) { return this.request<ApiMessage>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/messages`, input); }
  chatPoll(messageId: string) { return this.request<ChatPollResults>('GET', `/api/messages/${encodeURIComponent(messageId)}/poll`); }
  voteChatPoll(messageId: string, optionIds: string[]) { return this.request<ChatPollResults>('POST', `/api/messages/${encodeURIComponent(messageId)}/poll/vote`, {optionIds}); }
  addChatPollOption(messageId: string, label: string) { return this.request<ChatPollResults>('POST', `/api/messages/${encodeURIComponent(messageId)}/poll/options`, {label}); }
  editMessage(id: string, text: string) { return this.request<ApiMessage>('PATCH', `/api/messages/${encodeURIComponent(id)}`, {text}); }
  forwardMessage(id: string, conversationId: string) { return this.request<ApiMessage>('POST', `/api/messages/${encodeURIComponent(id)}/forward`, {conversationId}); }
  blockedUsers() { return this.request<string[]>('GET', '/api/blocks'); }
  blockUser(userId: string) { return this.request<{ok: true}>('POST', `/api/blocks/${encodeURIComponent(userId)}`); }
  unblockUser(userId: string) { return this.request<{ok: true}>('DELETE', `/api/blocks/${encodeURIComponent(userId)}`); }
  setMemberRestricted(communityId: string, userId: string, restricted: boolean) { return this.request<{community: ApiCommunity; members: ApiMember[]}>(restricted ? 'POST' : 'DELETE', `/api/communities/${encodeURIComponent(communityId)}/restrictions/${encodeURIComponent(userId)}`, {}); }
  deleteMessage(id: string) { return this.request<{ok: true}>('DELETE', `/api/messages/${encodeURIComponent(id)}`); }
  conversationExtras(conversationId: string) { return this.request<{pinned: ApiMessage | null; pins: ApiMessage[]; reactions: Record<string, {counts: {emoji: string; count: number}[]; mine: string | null}>; unreadMentions: number; mentions?: string[]}>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/extras`); }
  setMessageReaction(messageId: string, emoji: string | null) { return this.request<{counts: {emoji: string; count: number}[]; mine: string | null}>('POST', `/api/messages/${encodeURIComponent(messageId)}/reaction`, {emoji}); }
  /** Owner and admins of a group or channel only. Pins (or with pinned=false unpins) one message; messageId null unpins all. Up to 100. */
  setConversationPin(conversationId: string, messageId: string | null, pinned = true) { return this.request<{pinned: ApiMessage | null; pins: ApiMessage[]}>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/pin`, {messageId, pinned}); }
  /** Marks mentions read: all in the chat, or only `messageIds` (seen one by one via the "@" button). */
  markMentionsRead(conversationId: string, messageIds?: string[]) { return this.request<{ok: true}>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/mentions/read`, messageIds ? {messageIds} : {}); }
  userCalls(userId: string) { return this.request<CallStats>('GET', `/api/users/${encodeURIComponent(userId)}/calls`); }
  communityCalls(communityId: string) { return this.request<CallStats>('GET', `/api/communities/${encodeURIComponent(communityId)}/calls`); }
  /** Holder gate (hold ≥ minAmount to join and post). Owner or admin with an active Blue Star only; null removes it. */
  setCommunityGate(communityId: string, gate: {chain: string; address: string; minAmount: string} | null) { return this.request<{gate: CommunityGate | null}>('PUT', `/api/communities/${encodeURIComponent(communityId)}/gate`, gate ?? {gate: null}); }
  checkCommunityGate(communityId: string, fresh = false) { return this.request<GateCheck | null>('GET', `/api/communities/${encodeURIComponent(communityId)}/gate/check${fresh ? '?fresh=1' : ''}`); }
  linkSolanaWallet(address: string, signature: string) { return this.request<{address: string}>('POST', '/api/wallet/link-solana', {address, signature}); }
  referralsMe() { return this.request<ReferralsMe>('GET', '/api/referrals/me'); }
  lookupReferrer(username: string) { return this.request<ReferralUser>('GET', `/api/referrals/lookup?username=${encodeURIComponent(username)}`); }
  claimReferral(username: string, source: ReferralSource = 'manual') { return this.request<{referredBy: ReferralUser}>('POST', '/api/referrals/claim', {username, source}); }
  reportReferralTrade(input: {chain: string; txHash: string; requestId?: string}) { return this.request<ReferralTradeResult>('POST', '/api/referrals/trade', input); }
  sync(since: number) { return this.request<SyncResponse>('GET', `/api/sync?since=${since}`); }
}
