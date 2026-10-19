// Local-first chat state shared by Kivo web and mobile.
//
// The device is the archive: every message received is cached locally
// (per wallet) and kept after the server's rolling window expires it. The
// server is only a relay, so a device asks it for "everything after my
// cursor" and nothing else. Sends are optimistic with an idempotent
// clientId, so a flaky connection can retry without duplicates.

import type {KivoApi} from '../api/client';
import type {ApiConversation, ApiMessage, ApiProfile} from '../api/types';
import type {ChatPollPayload} from '../polls/types';
import {kivoUserIdForWallet, messageCharLimit, messageLength, normalizeWalletAddress, shortWallet, userLabel, walletAddressOfUserId} from '../api/types';
import type {KeyValueStorage} from '../storage';

export type LocalMessage = ApiMessage & {status: 'sent' | 'pending' | 'failed'; error?: string};

export type ChatState = {
  owner: string | null;
  conversations: ApiConversation[];
  messages: Record<string, LocalMessage[]>;
  cursor: number;
  lastRead: Record<string, number>;
  profiles: Record<string, ApiProfile>;
  online: boolean;
  lastError: string | null;
};

type Options = {
  api: KivoApi;
  storage: KeyValueStorage;
  /** Messages kept per conversation on this device. Phones can keep more than browsers. */
  maxPerConversation?: number;
  onIncoming?: (conversation: ApiConversation | undefined, message: ApiMessage) => void;
};

const KEY_PREFIX = 'kivo:chat:v1:';
const EMPTY = (): ChatState => ({owner: null, conversations: [], messages: {}, cursor: 0, lastRead: {}, profiles: {}, online: true, lastError: null});

let opts: Options | null = null;
let state: ChatState = EMPTY();
const listeners = new Set<(value: ChatState) => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Official (pinned) channels first, then most recent activity. */
const byPinnedThenRecent = (a: ApiConversation, b: ApiConversation) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastActivityAt - a.lastActivityAt;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** Last time a chat had activity (open, send, or a new message). A quiet open chat polls less often. */
let lastChatActivityAt = 0;
const QUIET_AFTER_MS = 2 * 60 * 1000;
let syncing = false;
let activeConversation: string | null = null;
let conversationsAt = 0;
const LIST_REFRESH_MS = 60_000;
let failures = 0;
let syncGeneration = 0;
/** Bumped whenever the chat owner changes; any await that resumes under a different owner must drop its result. */
let ownerGeneration = 0;

function emit(persistArchive = true) {
  listeners.forEach(listener => listener(state));
  // Presence/online updates are frequent; don't serialize the entire local
  // message archive unless persisted chat data actually changed.
  if (!persistArchive) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 700);
}

function persist() {
  if (!opts || !state.owner) return;
  const {online: _online, lastError: _error, ...rest} = state;
  // Pending/failed sends are kept so they survive a restart and can be retried.
  void Promise.resolve(opts.storage.setItem(KEY_PREFIX + state.owner, JSON.stringify(rest))).catch(() => {});
}

export function configureChat(options: Options) {
  opts = options;
}

export function getChatState(): ChatState { return state; }
export function subscribeChat(listener: (value: ChatState) => void) {
  listeners.add(listener);
  listener(state);
  return () => { listeners.delete(listener); };
}

/** Loads this wallet's on-device chat archive. Call on wallet change. */
export async function activateChat(address: string | null) {
  stopChatSync();
  // Solana addresses are case-sensitive: normalize, never blanket-lowercase.
  const owner = address ? normalizeWalletAddress(address) : null;
  const generation = ++ownerGeneration;
  activeConversation = null;
  state = {...EMPTY(), owner};
  if (owner && opts) {
    try {
      const raw = await opts.storage.getItem(KEY_PREFIX + owner);
      // Another wallet became active while this archive was loading: never mix accounts.
      if (generation !== ownerGeneration) return;
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ChatState>;
        state = {
          ...EMPTY(),
          owner,
          conversations: Array.isArray(saved.conversations) ? saved.conversations : [],
          messages: saved.messages && typeof saved.messages === 'object'
            ? Object.fromEntries(Object.entries(saved.messages).map(([id, list]) => [id, (Array.isArray(list) ? list : []).map(m => m.status === 'pending' ? {...m, status: 'failed' as const, error: m.error ?? 'Not sent. Tap to retry.'} : m)]))
            : {},
          cursor: typeof saved.cursor === 'number' ? saved.cursor : 0,
          lastRead: saved.lastRead && typeof saved.lastRead === 'object' ? saved.lastRead : {},
          profiles: saved.profiles && typeof saved.profiles === 'object' ? saved.profiles : {},
        };
      }
    } catch { /* unreadable archive: start fresh, server window refills it */ }
  }
  emit();
}

function cap(list: LocalMessage[]): LocalMessage[] {
  const max = opts?.maxPerConversation ?? 1000;
  return list.length > max ? list.slice(list.length - max) : list;
}

function merge(incoming: ApiMessage[]) {
  if (!incoming.length) return;
  const next = {...state.messages};
  for (const message of incoming) {
    const list = next[message.conversationId] ? [...next[message.conversationId]] : [];
    const index = list.findIndex(item => item.id === message.id);
    const local: LocalMessage = {...message, status: 'sent'};
    if (index >= 0) list[index] = local;
    else {
      list.push(local);
      list.sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
    }
    next[message.conversationId] = cap(list);
  }
  state = {...state, messages: next};
}

export async function refreshConversations() {
  if (!opts || !opts.api.isSignedIn(state.owner)) return;
  const generation = ownerGeneration;
  const conversations = await opts.api.conversations();
  conversationsAt = Date.now();
  if (generation !== ownerGeneration) return;
  const profiles = {...state.profiles};
  for (const conversation of conversations) if (conversation.peer) profiles[conversation.peer.userId] = conversation.peer;
  state = {...state, conversations, profiles};
  emit();
}

async function loadSenderProfiles(messages: ApiMessage[]) {
  if (!opts) return;
  const missing = Array.from(new Set(messages.map(m => m.senderId))).filter(id => !state.profiles[id]);
  if (!missing.length) return;
  try {
    const generation = ownerGeneration;
    const found = await opts.api.profiles(missing);
    if (generation !== ownerGeneration) return;
    const profiles = {...state.profiles};
    for (const profile of found) profiles[profile.userId] = profile;
    state = {...state, profiles};
  } catch { /* names fall back to short addresses */ }
}

/** Pulls everything after the local cursor. Safe to call any time. */
export async function syncNow(): Promise<void> {
  if (!opts || syncing || !opts.api.isSignedIn(state.owner)) return;
  syncing = true;
  const generation = ownerGeneration;
  const cursorBefore = state.cursor;
  const knownBefore = new Set(Object.values(state.messages).flat().map(m => m.id));
  try {
    let more = true;
    let rounds = 0;
    const fresh: ApiMessage[] = [];
    while (more && rounds++ < 10) {
      const page = await opts.api.sync(state.cursor);
      // The wallet changed during the request: this page belongs to the previous account.
      if (generation !== ownerGeneration) return;
      merge(page.messages);
      fresh.push(...page.messages);
      state = {...state, cursor: page.cursor};
      more = page.more;
    }
    const knownIds = new Set(state.conversations.map(c => c.id));
    if (fresh.some(m => !knownIds.has(m.conversationId)) || (fresh.length && !state.conversations.length)) await refreshConversations();
    else if (fresh.length) {
      // Keep list previews/order current without another request.
      const byConv = new Map<string, ApiMessage>();
      for (const m of fresh) byConv.set(m.conversationId, m);
      state = {...state, conversations: state.conversations.map(c => {
        const last = byConv.get(c.id);
        return last ? {...c, lastSeq: last.seq, lastPreview: last.deleted ? 'Message deleted' : last.text ? last.text.slice(0, 80) : '📷 Photo', lastSenderId: last.senderId, lastActivityAt: last.createdAt} : c;
      }).sort(byPinnedThenRecent)};
    }
    if (generation !== ownerGeneration) return;
    await loadSenderProfiles(fresh);
    if (generation !== ownerGeneration) return;
    if (cursorBefore === 0) {
      // First sync on this device: everything is history. Mark it read and don't notify for it.
      const lastRead = {...state.lastRead};
      for (const c of state.conversations) lastRead[c.id] = Math.max(lastRead[c.id] ?? 0, c.lastSeq ?? 0);
      for (const m of fresh) lastRead[m.conversationId] = Math.max(lastRead[m.conversationId] ?? 0, m.seq);
      state = {...state, lastRead};
    } else {
      for (const message of fresh) {
        // Edits and deletions come back through sync too; only brand-new messages notify.
        if (message.editedAt || message.deleted || knownBefore.has(message.id)) continue;
        if (message.senderId !== myUserId() && message.conversationId !== activeConversation) opts.onIncoming?.(state.conversations.find(c => c.id === message.conversationId), message);
      }
    }
    if (activeConversation) markRead(activeConversation, false);
    failures = 0;
    state = {...state, online: true, lastError: null};
    if (fresh.length > 0) lastChatActivityAt = Date.now();
    emit(fresh.length > 0 || state.cursor !== cursorBefore);
  } catch (error) {
    if (generation !== ownerGeneration) return;
    failures++;
    state = {...state, online: false, lastError: error instanceof Error ? error.message : 'Sync failed.'};
    emit(false);
  } finally {
    syncing = false;
  }
}

/** Polls the relay: fast while a chat is open, slower in the background, backing off when offline. */
export function startChatSync(shouldContinue: () => boolean = () => true) {
  stopChatSync();
  const generation = syncGeneration;
  const canContinue = () => generation === syncGeneration && shouldContinue();
  const loop = async () => {
    if (!canContinue()) return;
    // Self-repair the list: a failed first load used to leave it empty.
    if (!state.conversations.length || Date.now() - conversationsAt > LIST_REFRESH_MS) await refreshConversations().catch(() => {});
    await syncNow();
    if (!canContinue()) return;
    // 3 s while a chat is open and active, 6 s once it has been quiet for 2 minutes, 12 s in the background.
    const base = activeConversation ? (Date.now() - lastChatActivityAt > QUIET_AFTER_MS ? 6000 : 3000) : 12000;
    syncTimer = setTimeout(loop, Math.min(60_000, base * 2 ** Math.min(failures, 4)));
  };
  void refreshConversations().catch(() => {}).finally(() => {
    if (canContinue()) void loop();
  });
}

export function stopChatSync() {
  syncGeneration += 1;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
}

export function myUserId(): string | null {
  return state.owner ? kivoUserIdForWallet(state.owner) : null;
}

export async function refreshConversation(id: string): Promise<void> {
  if (!opts?.api.isSignedIn(state.owner)) return;
  try {
    const generation = ownerGeneration;
    const history = await opts.api.history(id);
    if (generation !== ownerGeneration) return;
    merge(history);
    await loadSenderProfiles(history);
    emit();
  } catch { /* normal chat rendering should not depend on a refresh */ }
}

export function setActiveConversation(id: string | null) {
  activeConversation = id;
  lastChatActivityAt = Date.now();
  if (id) {
    markRead(id);
    // Refresh recent history every time a conversation opens. Message media URLs
    // are signed and may have been cached locally from an earlier session; the
    // server returns a fresh URL for each history response.
    void refreshConversation(id);
    void syncNow();
  }
}

export function markRead(id: string, notify = true) {
  const list = state.messages[id] ?? [];
  const lastSeq = list.reduce((max, m) => Math.max(max, m.seq || 0), 0);
  if ((state.lastRead[id] ?? 0) >= lastSeq) return;
  state = {...state, lastRead: {...state.lastRead, [id]: lastSeq}};
  if (notify) emit();
}

export function unreadCount(id: string): number {
  const me = myUserId();
  const read = state.lastRead[id] ?? 0;
  return (state.messages[id] ?? []).filter(m => m.seq > read && m.senderId !== me && !m.deleted).length;
}

function clientId(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function upsertLocal(message: LocalMessage) {
  const list = [...(state.messages[message.conversationId] ?? [])];
  const index = list.findIndex(m => m.id === message.id);
  if (index >= 0) list[index] = message; else list.push(message);
  state = {...state, messages: {...state.messages, [message.conversationId]: cap(list)}};
  emit();
}

async function deliver(local: LocalMessage, payload: {text: string; mediaKey?: string; mediaWidth?: number; mediaHeight?: number; token?: {chain: string; address: string}; replyTo?: string}) {
  lastChatActivityAt = Date.now();
  if (!opts) return;
  const generation = ownerGeneration;
  try {
    const sent = await opts.api.send(local.conversationId, {...payload, clientId: local.id.replace(/^m_/, '')});
    if (generation !== ownerGeneration) return;
    const list = (state.messages[local.conversationId] ?? []).filter(m => m.id !== local.id && m.id !== sent.id);
    list.push({...sent, status: 'sent'});
    list.sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
    state = {...state, messages: {...state.messages, [local.conversationId]: cap(list)}, lastRead: {...state.lastRead, [local.conversationId]: Math.max(state.lastRead[local.conversationId] ?? 0, sent.seq)}};
    state = {...state, conversations: state.conversations.map(c => c.id === sent.conversationId ? {...c, lastSeq: sent.seq, lastPreview: sent.text ? sent.text.slice(0, 80) : '📷 Photo', lastSenderId: sent.senderId, lastActivityAt: sent.createdAt} : c).sort(byPinnedThenRecent)};
    emit();
  } catch (error) {
    if (generation !== ownerGeneration) return;
    upsertLocal({...local, status: 'failed', error: error instanceof Error ? error.message : 'Not sent.'});
  }
}

/**
 * token: the attached token. symbol/name/imageUrl are only for showing the
 * card while it sends; the server looks the token up itself and its answer
 * replaces them.
 */
/** Sends a poll only to Groups and Channels; the server remains authoritative for permissions. */
export async function sendPoll(conversationId: string, poll: ChatPollPayload) {
  if (!opts || !opts.api.isSignedIn(state.owner)) throw new Error('Connect your wallet to chat.');
  const conversation = state.conversations.find(item => item.id === conversationId);
  if (!conversation || (conversation.kind !== 'group' && conversation.kind !== 'channel')) {
    throw new Error('Polls are available in Groups and Channels, not direct messages.');
  }
  const sent = await opts.api.send(conversationId, {text: '', poll, clientId: clientId()});
  const list = [...(state.messages[conversationId] ?? [])].filter(message => message.id !== sent.id);
  list.push({...sent, status: 'sent'});
  list.sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
  state = {...state, messages: {...state.messages, [conversationId]: cap(list)}, lastRead: {...state.lastRead, [conversationId]: Math.max(state.lastRead[conversationId] ?? 0, sent.seq)}};
  state = {...state, conversations: state.conversations.map(item => item.id === sent.conversationId ? {...item, lastSeq: sent.seq, lastPreview: '📊 ' + sent.poll?.question, lastSenderId: sent.senderId, lastActivityAt: sent.createdAt} : item).sort(byPinnedThenRecent)};
  emit();
}

export async function sendText(conversationId: string, text: string, replyTo?: string, token?: {chain: string; address: string; symbol?: string; name?: string; imageUrl?: string | null}) {
  const trimmed = text.normalize('NFC').trim();
  if (!trimmed && !token) return;
  if (messageLength(trimmed) > messageCharLimit(true)) throw new Error('This message is too long.');
  const me = myUserId();
  if (!me) throw new Error('Connect your wallet to chat.');
  const local: LocalMessage = {seq: 0, id: 'm_' + clientId(), conversationId, senderId: me, text: trimmed, media: null, token: token ? {chain: token.chain, address: token.address, symbol: token.symbol ?? '', name: token.name ?? '', imageUrl: token.imageUrl ?? null} : null, replyTo: replyTo ?? null, createdAt: Date.now(), deleted: false, status: 'pending'};
  upsertLocal(local);
  await deliver(local, {text: trimmed, token: token ? {chain: token.chain, address: token.address} : undefined, replyTo});
}

/** Sends an already-compressed image (see web/mobile compressors). */
export async function sendImage(conversationId: string, image: {bytes: Blob | ArrayBuffer | Uint8Array; type: string; width: number; height: number; previewUrl: string}, caption = '', replyTo?: string): Promise<boolean> {
  const me = myUserId();
  if (!me || !opts) throw new Error('Connect your wallet to chat.');
  const local: LocalMessage = {seq: 0, id: 'm_' + clientId(), conversationId, senderId: me, text: caption.trim(), media: {url: image.previewUrl, width: image.width, height: image.height}, replyTo: replyTo ?? null, createdAt: Date.now(), deleted: false, status: 'pending'};
  upsertLocal(local);
  const generation = ownerGeneration;
  try {
    const uploaded = await opts.api.uploadImage(image.bytes, image.type, 'message');
    await deliver(local, {text: caption.trim(), mediaKey: uploaded.key, mediaWidth: image.width, mediaHeight: image.height, replyTo});
    return getChatState().messages[conversationId]?.some(m => m.id === local.id && m.status === 'sent') ?? false;
  } catch (error) {
    if (generation !== ownerGeneration) return false;
    upsertLocal({...local, status: 'failed', error: error instanceof Error ? error.message : 'Photo not sent.'});
    return false;
  }
}

export async function retryMessage(conversationId: string, id: string) {
  const message = state.messages[conversationId]?.find(m => m.id === id);
  if (!message || message.status !== 'failed' || message.media) return;
  upsertLocal({...message, status: 'pending', error: undefined});
  await deliver(message, {text: message.text, replyTo: message.replyTo ?? undefined});
}

export function discardMessage(conversationId: string, id: string) {
  state = {...state, messages: {...state.messages, [conversationId]: (state.messages[conversationId] ?? []).filter(m => m.id !== id || m.status === 'sent')}};
  emit();
}

export async function editMessage(conversationId: string, id: string, text: string) {
  if (!opts) throw new Error('Chat is not ready.');
  const trimmed = text.normalize('NFC').trim();
  if (!trimmed) throw new Error('Message cannot be empty.');
  if (messageLength(trimmed) > messageCharLimit(true)) throw new Error('This message is too long.');
  const original = state.messages[conversationId]?.find(m => m.id === id);
  if (!original || original.senderId !== myUserId() || original.deleted || original.status !== 'sent') throw new Error('Only your sent messages can be edited.');
  const updated = await opts.api.editMessage(id, trimmed);
  const list = (state.messages[conversationId] ?? []).map(m => m.id === id ? {...updated, status: 'sent' as const} : m)
    .sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
  state = {...state, messages: {...state.messages, [conversationId]: cap(list)}, conversations: state.conversations.map(c => c.id === conversationId && c.lastSeq === original.seq ? {...c, lastSeq: updated.seq, lastPreview: updated.text ? updated.text.slice(0, 80) : '📷 Photo', lastSenderId: updated.senderId} : c)};
  emit();
}

export async function forwardMessage(conversationId: string, id: string, targetConversationId: string) {
  if (!opts) throw new Error('Chat is not ready.');
  if (conversationId === targetConversationId) throw new Error('Choose a different conversation.');
  const source = state.messages[conversationId]?.find(m => m.id === id);
  if (!source || source.deleted || source.status !== 'sent') throw new Error('This message cannot be forwarded.');
  const forwarded = await opts.api.forwardMessage(id, targetConversationId);
  const list = [...(state.messages[targetConversationId] ?? []).filter(m => m.id !== forwarded.id), {...forwarded, status: 'sent' as const}]
    .sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
  state = {...state, messages: {...state.messages, [targetConversationId]: cap(list)}, conversations: state.conversations.map(c => c.id === targetConversationId ? {...c, lastSeq: Math.max(c.lastSeq, forwarded.seq), lastPreview: forwarded.text ? forwarded.text.slice(0, 80) : '📷 Photo', lastSenderId: forwarded.senderId, lastActivityAt: forwarded.createdAt} : c)};
  emit();
}

export async function deleteForEveryone(conversationId: string, id: string) {
  if (!opts) return;
  await opts.api.deleteMessage(id);
  state = {...state, messages: {...state.messages, [conversationId]: (state.messages[conversationId] ?? []).map(m => m.id === id ? {...m, text: '', media: null, deleted: true} : m)}};
  emit();
}

export async function openDirectMessage(address: string): Promise<string> {
  if (!opts) throw new Error('Chat is not ready.');
  const {id} = await opts.api.openDm(address);
  await refreshConversations();
  return id;
}

export function displayName(userId: string | null | undefined): string {
  if (!userId) return 'Unknown';
  if (userId === myUserId()) return 'You';
  const profile = state.profiles[userId];
  return userLabel(profile?.username, userId);
}

export function rememberProfiles(profiles: ApiProfile[]) {
  if (!profiles.length) return;
  const next = {...state.profiles};
  for (const profile of profiles) next[profile.userId] = profile;
  state = {...state, profiles: next};
  emit();
}
