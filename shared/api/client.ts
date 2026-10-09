// Typed client for the Kivo social API, shared by web and mobile.
import type {KeyValueStorage} from '../storage';
import type {ProfileSocial, PublicCommunityCard} from './types';
import type {ApiCommunity, ApiConversation, ApiMember, ApiMessage, ApiProfile, AuthChallenge, AuthSession, CommunityKind, ProfileApprovalChallenge, SyncResponse} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type KivoApiOptions = {baseUrl: string; storage: KeyValueStorage; sessionStorage?: KeyValueStorage; client: 'web' | 'mobile'};
const SESSION_KEY = 'kivo:api-session:v1';

export class KivoApi {
  private baseUrl: string;
  private storage: KeyValueStorage;
  private sessionStorage: KeyValueStorage;
  private client: 'web' | 'mobile';
  private session: {token: string; expiresAt: number; address: string} | null = null;
  private listeners = new Set<() => void>();

  constructor(options: KivoApiOptions) { this.baseUrl = options.baseUrl.replace(/\/$/, ''); this.storage = options.storage; this.sessionStorage = options.sessionStorage ?? options.storage; this.client = options.client; }
  onSessionChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.listeners.forEach(listener => listener()); }

  async restore(address: string | null): Promise<boolean> {
    this.session = null;
    if (!address) { this.emit(); return false; }
    try {
      const raw = await this.sessionStorage.getItem(SESSION_KEY);
      const saved = raw ? JSON.parse(raw) as {token: string; expiresAt: number; address: string} : null;
      if (saved && saved.address === address.toLowerCase() && saved.expiresAt > Date.now() + 60_000 && /^kv_[0-9a-f]{64}$/.test(saved.token)) this.session = saved;
    } catch {}
    this.emit();
    return Boolean(this.session);
  }

  isSignedIn(address?: string | null): boolean { return Boolean(this.session && (!address || this.session.address === address.toLowerCase())); }

  async signIn(address: string, sign: (message: string) => Promise<string>): Promise<AuthSession> {
    const challenge = await this.request<AuthChallenge>('POST', '/api/auth/challenge', {address, client: this.client}, false);
    const signature = await sign(challenge.message);
    const session = await this.request<AuthSession>('POST', '/api/auth/verify', {address, nonce: challenge.nonce, signature}, false);
    this.session = {token: session.token, expiresAt: session.expiresAt, address: address.toLowerCase()};
    await this.sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    this.emit();
    return session;
  }

  async signOut() {
    if (this.session) await this.request('POST', '/api/auth/signout', {}).catch(() => {});
    this.session = null;
    await this.sessionStorage.removeItem?.(SESSION_KEY);
    this.emit();
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
    try { response = await fetch(this.baseUrl + path, {method, headers, body: payload}); }
    catch { throw new ApiError(0, 'You appear to be offline. Kivo will retry when you are back.'); }
    const data = await response.json().catch(() => null) as (T & {error?: string}) | null;
    if (!response.ok) {
      if (response.status === 401 && sessionAtRequest && this.session?.token === sessionAtRequest.token) {
        this.session = null;
        await this.sessionStorage.removeItem?.(SESSION_KEY);
        this.emit();
      }
      throw new ApiError(response.status, data?.error ?? `Request failed (${response.status}).`);
    }
    return data as T;
  }

  me() { return this.request<ApiProfile>('GET', '/api/me'); }
  requestProfileApproval(input: {username: string; bio: string; avatarAction: 'keep' | 'remove' | 'upload'}) {
    return this.request<ProfileApprovalChallenge>('POST', '/api/profile/approval-challenge', input);
  }
  updateProfile(input: {username: string; bio: string; avatarKey?: string | null; approvalNonce: string; approvalSignature: string; approvalAvatarAction: 'keep' | 'remove' | 'upload'}) {
    return this.request<ApiProfile>('PUT', '/api/profile', input);
  }
  searchProfiles(q: string) { return this.request<ApiProfile[]>('GET', `/api/profiles?q=${encodeURIComponent(q)}`, undefined, false); }
  profiles(ids: string[]) { return ids.length ? this.request<ApiProfile[]>('GET', `/api/profiles?ids=${encodeURIComponent(ids.slice(0, 100).join(','))}`, undefined, false) : Promise.resolve([]); }
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
  join(id: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('POST', `/api/communities/${encodeURIComponent(id)}/join`, {}); }
  leave(id: string) { return this.request<{ok: true}>('POST', `/api/communities/${encodeURIComponent(id)}/leave`, {}); }
  addMember(id: string, address: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>('POST', `/api/communities/${encodeURIComponent(id)}/members`, {address}); }
  removeMember(id: string, userId: string) { return this.request<{community: ApiCommunity; members: ApiMember[]}>( 'DELETE', `/api/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`); }
  setAdmin(id: string, userId: string, promote: boolean) { return this.request<{community: ApiCommunity; members: ApiMember[]}>(promote ? 'POST' : 'DELETE', `/api/communities/${encodeURIComponent(id)}/admins/${encodeURIComponent(userId)}`, promote ? {} : undefined); }
  conversations() { return this.request<ApiConversation[]>('GET', '/api/conversations'); }
  openDm(address: string) { return this.request<{id: string}>('POST', '/api/conversations/dm', {address}); }
  history(conversationId: string, before?: number) { return this.request<ApiMessage[]>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/messages${before ? `?before=${before}` : ''}`); }
  send(conversationId: string, input: {text: string; mediaKey?: string; mediaWidth?: number; mediaHeight?: number; replyTo?: string; clientId: string}) { return this.request<ApiMessage>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/messages`, input); }
  editMessage(id: string, text: string) { return this.request<ApiMessage>('PATCH', `/api/messages/${encodeURIComponent(id)}`, {text}); }
  forwardMessage(id: string, conversationId: string) { return this.request<ApiMessage>('POST', `/api/messages/${encodeURIComponent(id)}/forward`, {conversationId}); }
  blockedUsers() { return this.request<string[]>('GET', '/api/blocks'); }
  blockUser(userId: string) { return this.request<{ok: true}>('POST', `/api/blocks/${encodeURIComponent(userId)}`); }
  unblockUser(userId: string) { return this.request<{ok: true}>('DELETE', `/api/blocks/${encodeURIComponent(userId)}`); }
  setMemberRestricted(communityId: string, userId: string, restricted: boolean) { return this.request<{community: ApiCommunity; members: ApiMember[]}>(restricted ? 'POST' : 'DELETE', `/api/communities/${encodeURIComponent(communityId)}/restrictions/${encodeURIComponent(userId)}`, {}); }
  deleteMessage(id: string) { return this.request<{ok: true}>('DELETE', `/api/messages/${encodeURIComponent(id)}`); }
  sync(since: number) { return this.request<SyncResponse>('GET', `/api/sync?since=${since}`); }
}
