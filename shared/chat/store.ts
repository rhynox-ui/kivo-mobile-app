// Local-first chat state shared by Kivo web and mobile.
//
// The device is the archive: every message received is cached locally
// (per wallet) and kept after the server's rolling window expires it. The
// server is only a relay, so a device asks it for "everything after my
// cursor" and nothing else. Sends are optimistic with an idempotent
// clientId, so a flaky connection can retry without duplicates.

import type {KivoApi} from '../api/client';
import type {ApiConversation, ApiMessage, ApiProfile} from '../api/types';
import {API_LIMITS} from '../api/types';
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
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let activeConversation: string | null = null;
let failures = 0;

function emit() {
  listeners.forEach(listener => listener(state));
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
  const owner = address ? address.toLowerCase() : null;
  state = {...EMPTY(), owner};
  if (owner && opts) {
    try {
      const raw = await opts.storage.getItem(KEY_PREFIX + owner);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ChatState>;
        state = {
          ...state,
          conversations: Array.isArray(saved.conversations) ? saved.conversations : [],
          messages: saved.messages && typeof saved.messages === 'object' ? saved.messages : {},
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
  const conversations = await opts.api.conversations();
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
    const found = await opts.api.profiles(missing);
    const profiles = {...state.profiles};
    for (const profile of found) profiles[profile.userId] = profile;
    state = {...state, profiles};
  } catch { /* names fall back to short addresses */ }
}

/** Pulls everything after the local cursor. Safe to call any time. */
export async function syncNow(): Promise<void> {
  if (!opts || syncing || !opts.api.isSignedIn(state.owner)) return;
  syncing = true;
  try {
    let more = true;
    let rounds = 0;
    const fresh: ApiMessage[] = [];
    while (more && rounds++ < 10) {
      const page = await opts.api.sync(state.cursor);
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
      }).sort((a, b) => b.lastActivityAt - a.lastActivityAt)};
    }
    await loadSenderProfiles(fresh);
    for (const message of fresh) {
      if (message.senderId !== myUserId() && message.conversationId !== activeConversation) opts.onIncoming?.(state.conversations.find(c => c.id === message.conversationId), message);
    }
    if (activeConversation) markRead(activeConversation, false);
    failures = 0;
    state = {...state, online: true, lastError: null};
    emit();
  } catch (error) {
    failures++;
    state = {...state, online: false, lastError: error instanceof Error ? error.message : 'Sync failed.'};
    emit();
  } finally {
    syncing = false;
  }
}

/** Polls the relay: fast while a chat is open, slower in the background, backing off when offline. */
export function startChatSync() {
  stopChatSync();
  const loop = async () => {
    await syncNow();
    const base = activeConversation ? 3000 : 12000;
    syncTimer = setTimeout(loop, Math.min(60_000, base * 2 ** Math.min(failures, 4)));
  };
  void refreshConversations().catch(() => {}).finally(loop);
}

export function stopChatSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
}

export function myUserId(): string | null {
  return state.owner ? 'kivo:' + state.owner : null;
}

export function setActiveConversation(id: string | null) {
  activeConversation = id;
  if (id) {
    markRead(id);
    // A freshly joined community has history from before we joined; fetch it once.
    if (!(state.messages[id]?.length) && opts?.api.isSignedIn(state.owner)) {
      opts.api.history(id).then(history => { merge(history); void loadSenderProfiles(history).then(emit); emit(); }).catch(() => {});
    }
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

async function deliver(local: LocalMessage, payload: {text: string; mediaKey?: string; mediaWidth?: number; mediaHeight?: number; replyTo?: string}) {
  if (!opts) return;
  try {
    const sent = await opts.api.send(local.conversationId, {...payload, clientId: local.id.replace(/^m_/, '')});
    const list = (state.messages[local.conversationId] ?? []).filter(m => m.id !== local.id && m.id !== sent.id);
    list.push({...sent, status: 'sent'});
    list.sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
    state = {...state, messages: {...state.messages, [local.conversationId]: cap(list)}, lastRead: {...state.lastRead, [local.conversationId]: Math.max(state.lastRead[local.conversationId] ?? 0, sent.seq)}};
    state = {...state, conversations: state.conversations.map(c => c.id === sent.conversationId ? {...c, lastSeq: sent.seq, lastPreview: sent.text ? sent.text.slice(0, 80) : '📷 Photo', lastSenderId: sent.senderId, lastActivityAt: sent.createdAt} : c).sort((a, b) => b.lastActivityAt - a.lastActivityAt)};
    emit();
  } catch (error) {
    upsertLocal({...local, status: 'failed', error: error instanceof Error ? error.message : 'Not sent.'});
  }
}

export async function sendText(conversationId: string, text: string, replyTo?: string) {
  const trimmed = text.normalize('NFC').trim();
  if (!trimmed) return;
  if (trimmed.length > API_LIMITS.maxMessageChars) throw new Error(`Messages are limited to ${API_LIMITS.maxMessageChars} characters.`);
  const me = myUserId();
  if (!me) throw new Error('Connect your wallet to chat.');
  const local: LocalMessage = {seq: 0, id: 'm_' + clientId(), conversationId, senderId: me, text: trimmed, media: null, replyTo: replyTo ?? null, createdAt: Date.now(), deleted: false, status: 'pending'};
  upsertLocal(local);
  await deliver(local, {text: trimmed, replyTo});
}

/** Sends an already-compressed image (see web/mobile compressors). */
export async function sendImage(conversationId: string, image: {bytes: Blob | ArrayBuffer | Uint8Array; type: string; width: number; height: number; previewUrl: string}, caption = '') {
  const me = myUserId();
  if (!me || !opts) throw new Error('Connect your wallet to chat.');
  const local: LocalMessage = {seq: 0, id: 'm_' + clientId(), conversationId, senderId: me, text: caption.trim(), media: {url: image.previewUrl, width: image.width, height: image.height}, replyTo: null, createdAt: Date.now(), deleted: false, status: 'pending'};
  upsertLocal(local);
  try {
    const uploaded = await opts.api.uploadImage(image.bytes, image.type, 'message');
    await deliver(local, {text: caption.trim(), mediaKey: uploaded.key, mediaWidth: image.width, mediaHeight: image.height});
  } catch (error) {
    upsertLocal({...local, status: 'failed', error: error instanceof Error ? error.message : 'Photo not sent.'});
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
  if (trimmed.length > API_LIMITS.maxMessageChars) throw new Error(`Messages are limited to ${API_LIMITS.maxMessageChars} characters.`);
  const original = state.messages[conversationId]?.find(m => m.id === id);
  if (!original || original.senderId !== myUserId() || original.deleted || original.status !== 'sent') throw new Error('Only your sent messages can be edited.');
  const updated = await opts.api.editMessage(id, trimmed);
  const list = (state.messages[conversationId] ?? []).map(m => m.id === id ? {...updated, status: 'sent' as const} : m)
    .sort((a, b) => a.createdAt - b.createdAt || (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
  state = {...state, messages: {...state.messages, [conversationId]: cap(list)}, conversations: state.conversations.map(c => c.id === conversationId && c.lastSeq <= updated.seq ? {...c, lastSeq: updated.seq, lastPreview: updated.text ? updated.text.slice(0, 80) : '📷 Photo', lastSenderId: updated.senderId} : c)};
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
  if (profile?.username) return '@' + profile.username;
  const address = userId.replace(/^kivo:/, '');
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function rememberProfiles(profiles: ApiProfile[]) {
  if (!profiles.length) return;
  const next = {...state.profiles};
  for (const profile of profiles) next[profile.userId] = profile;
  state = {...state, profiles: next};
  emit();
}
