import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { API_LIMITS, normalizeWalletAddress, shortWallet, walletAddressOfUserId, type ApiBan, type ApiCommunity, type ApiMember, type CommunitySettingsInput } from '@kivo/shared/api/types';
import { canDemoteGroupAdmin, canPromoteGroupAdmin, canRemoveGroupMember } from '@kivo/shared/social/rules';
import type { KivoGroup } from '@kivo/shared/social/types';
import { refreshConversations } from '@kivo/shared/chat/store';
import { getProfile } from '@kivo/shared/profile/store';
import { KivoButton } from '../components';
import { kivoTheme } from '../theme/kivoTheme';
import { api, socialReady } from '../state/session';
import { pickAvatarPhoto } from '../utils/pickAvatarPhoto';
import { Avatar } from './ChatListScreen';

const KIVO_ORIGIN = 'https://kivotrade.site';
type Detail = { community: ApiCommunity; members: ApiMember[] };

const noun = (c: ApiCommunity) => (c.kind === 'channel' ? 'channel' : 'group');
function personName(userId: string, profile: ApiMember['profile']) {
  return profile?.username ? '@' + profile.username : shortWallet(walletAddressOfUserId(userId));
}
/** Same link the web app shares: the invite link for private communities, the public page otherwise. */
export function communityShareLink(c: ApiCommunity): string {
  const publicUrl = `${KIVO_ORIGIN}/${c.kind}/${c.id}`;
  if (c.visibility !== 'private') return publicUrl;
  return c.inviteCode ? `${KIVO_ORIGIN}/join/${c.inviteCode}` : publicUrl;
}

/** Manage a group/channel: owner and admins only. The server enforces every rule again. */
export function CommunitySettingsScreen({ id, onBack, onDeleted, onOpenPerson }: { id: string; onBack: () => void; onDeleted: () => void; onOpenPerson?: (userId: string) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [bans, setBans] = useState<ApiBan[] | null>(null);
  const [bansError, setBansError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');
  const [notice, setNotice] = useState('');
  // Synchronous guard: one manage action at a time, so a double tap never sends a change twice.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const loadBans = useCallback(() => api.bans(id)
    .then(list => { setBans(list); setBansError(''); })
    .catch(e => setBansError(e instanceof Error ? e.message : 'Could not load banned users.')), [id]);
  const load = useCallback(async (resetFields = false) => {
    try {
      const detail = await api.community(id);
      setData(detail);
      setError('');
      if (resetFields) { setName(detail.community.name); setDescription(detail.community.description ?? ''); }
      if (detail.community.myRole === 'owner' || detail.community.myRole === 'admin') void loadBans();
    } catch (e) { setError(e instanceof Error ? e.message : 'Not available.'); }
  }, [id, loadBans]);
  useEffect(() => { void load(true); }, [load]);

  /** Run one server action; report the server's own error; refresh only after real success. */
  const run = async (work: () => Promise<unknown>, success: string, opts: { resetFields?: boolean; after?: () => void } = {}) => {
    if (busyRef.current) return;
    if (!socialReady()) { Alert.alert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work();
      await refreshConversations().catch(() => {});
      if (opts.after) { opts.after(); return; }
      setNotice(success);
      await load(opts.resetFields);
    } catch (e) {
      if (e instanceof CancelledPick) return;
      Alert.alert('Manage', e instanceof Error ? e.message : 'Action failed. Please try again.');
    } finally { busyRef.current = false; setBusy(false); }
  };
  const save = (input: CommunitySettingsInput, success: string, resetFields = false) => run(() => api.updateCommunity(id, input), success, { resetFields });
  const confirm = (title: string, message: string, label: string, onConfirm: () => void) =>
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: 'destructive', onPress: onConfirm }]);

  if (error && !data) return <View style={styles.root}><Header title="Manage" onBack={onBack} /><Text style={styles.mutedCenter}>{error}</Text></View>;
  if (!data) return <View style={styles.root}><Header title="Manage" onBack={onBack} /><ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 40 }} /></View>;

  const { community: c, members } = data;
  if (c.myRole !== 'owner' && c.myRole !== 'admin') {
    return <View style={styles.root}><Header title="Manage" onBack={onBack} /><Text style={styles.mutedCenter}>Only the owner and admins can change this {noun(c)}.</Text></View>;
  }
  const owner = c.myRole === 'owner';
  const isChannel = c.kind === 'channel';
  const me = socialReady() ? getProfile().userId : null;
  const group: KivoGroup = { id: c.id, name: c.name, ownerId: c.ownerId, adminIds: members.filter(m => m.role === 'admin').map(m => m.userId), memberCount: c.memberCount };
  const team = members.filter(m => m.role !== 'member');
  const regular = members.filter(m => m.role === 'member');
  const link = communityShareLink(c);
  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2 && trimmedName.length <= API_LIMITS.maxCommunityNameChars;
  const descriptionValid = description.trim().length <= API_LIMITS.maxCommunityDescriptionChars;
  const infoChanged = trimmedName !== c.name || description.trim() !== (c.description ?? '');
  const membersWord = isChannel ? 'subscribers' : 'members';

  const changePhoto = () => run(async () => {
    const picked = await pickAvatarPhoto();
    if (!picked) throw new CancelledPick();
    const uploaded = await api.uploadImage(picked.bytes, picked.type, 'avatar');
    await api.updateCommunity(id, { avatarKey: uploaded.key });
  }, 'Photo updated');

  const memberRow = (member: ApiMember) => {
    const target = member.userId;
    const label = personName(target, member.profile);
    const canManage = Boolean(me && canRemoveGroupMember(me, target, group));
    return (
      <View key={target} style={styles.memberRow}>
        <Pressable onPress={() => onOpenPerson?.(target)} style={styles.memberMain}>
          <Avatar name={label} uri={member.profile?.avatarUrl} size={38} />
          <View style={styles.flex}>
            <Text style={styles.memberName} numberOfLines={1}>{label}</Text>
            <Text style={styles.small}>{member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : isChannel ? 'Subscriber' : 'Member'}{member.restricted ? ' · muted' : ''}</Text>
          </View>
        </Pressable>
        <View style={styles.chips}>
          {me && canPromoteGroupAdmin(me, target, group) && <Chip label="Make admin" disabled={busy} onPress={() => run(() => api.setAdmin(id, target, true), `${label} is now an admin`)} />}
          {me && canDemoteGroupAdmin(me, target, group) && <Chip label="Dismiss admin" disabled={busy} onPress={() => confirm('Dismiss admin', `${label} will become a regular ${isChannel ? 'subscriber' : 'member'}.`, 'Dismiss', () => run(() => api.setAdmin(id, target, false), 'Admin removed'))} />}
          {/* Muting applies to groups; in channels only the team posts anyway. */}
          {!isChannel && member.role === 'member' && canManage && <Chip label={member.restricted ? 'Unmute' : 'Mute'} disabled={busy} onPress={() => run(() => api.setMemberRestricted(id, target, !member.restricted), member.restricted ? `${label} can send messages again` : `${label} is muted`)} />}
          {canManage && <Chip danger label="Remove" disabled={busy} onPress={() => confirm(`Remove ${isChannel ? 'subscriber' : 'member'}`, `Remove ${label} from ${c.name}? They can rejoin${c.visibility === 'public' ? '' : ' with an invite link'}.`, 'Remove', () => run(() => api.removeMember(id, target), 'Removed'))} />}
          {canManage && <Chip danger label="Ban" disabled={busy} onPress={() => confirm('Ban', `${label} is removed from ${c.name} and can’t rejoin or be re-added until unbanned.`, 'Ban', () => run(() => api.setBanned(id, target, true), 'Banned'))} />}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <Header title={`Manage ${noun(c)}`} subtitle={c.name} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {busy ? <ActivityIndicator color={kivoTheme.colors.accent} /> : null}

        {/* Photo */}
        <View style={[styles.card, styles.photoCard]}>
          <Pressable accessibilityLabel="Change photo" disabled={busy} onPress={changePhoto}>
            <Avatar name={c.name} uri={c.avatarUrl} size={88} verified={c.isVerified === true} />
            <View style={styles.photoBadge}><Text style={styles.photoBadgeText}>✎</Text></View>
          </Pressable>
          <View style={styles.photoActions}>
            <Chip label={c.avatarUrl ? 'Change photo' : 'Set photo'} disabled={busy} onPress={changePhoto} />
            {c.avatarUrl ? <Chip danger label="Remove" disabled={busy} onPress={() => confirm('Remove photo', `Remove the ${noun(c)} photo?`, 'Remove', () => save({ avatarKey: null }, 'Photo removed'))} /> : null}
          </View>
          <Text style={styles.small}>Photos are resized and compressed on your device before upload.</Text>
        </View>

        {/* Info */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Info</Text>
          <Text style={styles.label}>Name</Text>
          <TextInput value={name} onChangeText={setName} maxLength={API_LIMITS.maxCommunityNameChars} placeholder="Name" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} editable={!busy} />
          {!nameValid ? <Text style={styles.error}>Name must be 2–{API_LIMITS.maxCommunityNameChars} characters.</Text> : null}
          <View style={styles.labelRow}><Text style={styles.label}>Description</Text><Text style={styles.small}>{description.length}/{API_LIMITS.maxCommunityDescriptionChars}</Text></View>
          <TextInput value={description} onChangeText={setDescription} maxLength={API_LIMITS.maxCommunityDescriptionChars} multiline placeholder={`What is this ${noun(c)} about?`} placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.input, styles.multiline]} editable={!busy} />
          <KivoButton label="Save" disabled={busy || !nameValid || !descriptionValid || !infoChanged} onPress={() => save({ name: trimmedName, description: description.trim() }, 'Info saved', true)} />
        </View>

        {/* Type and link */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{isChannel ? 'Channel' : 'Group'} type</Text>
          {owner
            ? <View style={styles.segmented}>
                {(['public', 'private'] as const).map(v => (
                  <Pressable key={v} disabled={busy} accessibilityRole="button" accessibilityState={{ selected: c.visibility === v }}
                    onPress={() => { if (c.visibility !== v) void save({ visibility: v }, v === 'public' ? 'Now public' : 'Now private'); }}
                    style={[styles.segment, c.visibility === v && styles.segmentActive]}>
                    <Text style={[styles.segmentText, c.visibility === v && styles.segmentTextActive]}>{v === 'public' ? 'Public' : 'Private'}</Text>
                  </Pressable>
                ))}
              </View>
            : <Text style={styles.muted}>{c.visibility === 'public' ? 'Public' : 'Private'} — only the owner can change this.</Text>}
          <Text style={styles.small}>{c.visibility === 'public' ? `Anyone can find this ${noun(c)} in search and join.` : 'Hidden from search. People join with the invite link or when added.'}</Text>
          <View style={styles.inviteRow}>
            <Text selectable style={styles.inviteLink} numberOfLines={2}>{link}</Text>
            {/* No clipboard module in the app: the link text is selectable, and Share offers "Copy" on both platforms. */}
            <Chip label="Share" onPress={() => { void Share.share({ message: link }).catch(() => {}); }} />
          </View>
          {c.visibility === 'private' ? <Chip label="Reset invite link" disabled={busy} onPress={() => confirm('Reset invite link', 'The current invite link will stop working. Anyone who hasn’t joined yet will need the new link.', 'Reset', () => run(() => api.resetInvite(id), 'New invite link created — the old one no longer works'))} /> : null}
        </View>

        {/* Permissions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Permissions</Text>
          {isChannel
            ? <Text style={styles.muted}>Owner and admins post. Subscribers read.</Text>
            : <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text style={styles.memberName}>Only admins can send messages</Text>
                  <Text style={styles.small}>{owner ? 'Members can still read and react.' : 'Only the owner can change this.'}</Text>
                </View>
                <Switch value={Boolean(c.onlyAdminsPost)} disabled={!owner || busy}
                  onValueChange={value => { void save({ onlyAdminsPost: value }, value ? 'Only admins can send now' : 'Everyone can send now'); }}
                  trackColor={{ true: kivoTheme.colors.accent, false: kivoTheme.colors.surfaceRaised }} thumbColor={kivoTheme.colors.cream} />
              </View>}
        </View>

        {/* Administrators */}
        <View style={styles.card}>
          <View style={styles.labelRow}><Text style={styles.cardTitle}>Administrators</Text><Text style={styles.small}>{team.length}</Text></View>
          {team.map(memberRow)}
          <Text style={styles.small}>• The owner has full control and can’t be removed or demoted.{'\n'}• Only the owner adds or removes admins{owner ? ' (use “Make admin” on a member below)' : ''}.{'\n'}• Admins edit info, add, remove, ban{isChannel ? '' : ' and mute'} {membersWord}.{'\n'}• Being an admin never makes someone the owner.</Text>
        </View>

        {/* Members */}
        <View style={styles.card}>
          <View style={styles.labelRow}><Text style={styles.cardTitle}>{isChannel ? 'Subscribers' : 'Members'}</Text><Text style={styles.small}>{c.memberCount}</Text></View>
          <View style={styles.addRow}>
            <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} placeholder="Wallet address (EVM or Solana)" placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.input, styles.flex]} editable={!busy} />
            <Chip label="Add" disabled={busy || !address.trim()} onPress={() => {
              // Solana addresses are case-sensitive: normalize, never lower-case them.
              const wallet = normalizeWalletAddress(address.trim());
              if (!wallet) { Alert.alert('Add', 'Enter a valid EVM (0x…) or Solana wallet address.'); return; }
              void run(async () => { await api.addMember(id, wallet); setAddress(''); }, 'Added');
            }} />
          </View>
          {regular.length ? regular.map(memberRow) : <Text style={styles.muted}>No other {membersWord} yet. Share the link to invite people.</Text>}
          {members.length < c.memberCount ? <Text style={styles.small}>Showing the first {members.length} of {c.memberCount}.</Text> : null}
        </View>

        {/* Banned */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Banned users</Text>
          <Text style={styles.small}>Banned people are removed and can’t rejoin or be re-added until you unban them.</Text>
          {bansError ? <Text style={styles.error}>{bansError}</Text>
            : bans == null ? <ActivityIndicator color={kivoTheme.colors.accent} />
            : bans.length === 0 ? <Text style={styles.muted}>No one is banned.</Text>
            : bans.map(ban => {
                const label = personName(ban.userId, ban.profile);
                return (
                  <View key={ban.userId} style={styles.memberRow}>
                    <Pressable onPress={() => onOpenPerson?.(ban.userId)} style={styles.memberMain}>
                      <Avatar name={label} uri={ban.profile?.avatarUrl} size={38} />
                      <View style={styles.flex}><Text style={styles.memberName} numberOfLines={1}>{label}</Text><Text style={styles.small}>Banned {new Date(ban.bannedAt).toLocaleDateString()}</Text></View>
                    </Pressable>
                    <Chip label="Unban" disabled={busy} onPress={() => run(() => api.setBanned(id, ban.userId, false), `${label} unbanned`)} />
                  </View>
                );
              })}
        </View>

        {/* Danger zone */}
        {owner && <View style={[styles.card, styles.dangerCard]}>
          <Text style={styles.cardTitle}>Danger zone</Text>
          {!deleteOpen
            ? <KivoButton variant="danger" label={`Delete ${noun(c)}`} disabled={busy} onPress={() => { setDeleteTyped(''); setDeleteOpen(true); }} />
            : <>
                <Text style={styles.muted}>This deletes “{c.name}” and all its messages for everyone. It can’t be undone. Type the {noun(c)} name to confirm.</Text>
                <TextInput value={deleteTyped} onChangeText={setDeleteTyped} autoCapitalize="none" autoCorrect={false} placeholder={c.name} placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} editable={!busy} />
                <KivoButton variant="danger" label="Delete for everyone" disabled={busy || deleteTyped.trim() !== c.name}
                  onPress={() => { if (deleteTyped.trim() === c.name) void run(() => api.deleteCommunity(id), `${isChannel ? 'Channel' : 'Group'} deleted`, { after: onDeleted }); }} />
                <KivoButton variant="secondary" label="Cancel" disabled={busy} onPress={() => setDeleteOpen(false)} />
              </>}
        </View>}
      </ScrollView>
    </View>
  );
}

/** Thrown when the person closes the picker, so `run` neither reports an error nor a success. */
class CancelledPick extends Error { constructor() { super('cancelled'); } }

function Header({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
      <View style={styles.flex}>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.small} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

function Chip({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.chip, danger && styles.chipDanger, disabled && styles.disabled]}>
      <Text style={[styles.chipText, danger && styles.chipTextDanger]}>{label}</Text>
    </Pressable>
  );
}

const k = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: k.background },
  header: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: k.border },
  back: { color: k.cream, fontSize: 36, width: 24 },
  headerTitle: { color: k.text, fontSize: 17, fontWeight: '800' },
  body: { padding: 18, gap: 12, paddingBottom: 48 },
  notice: { color: k.success, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  card: { padding: 14, borderRadius: 18, backgroundColor: k.surface, borderWidth: 1, borderColor: k.border, gap: 8 },
  dangerCard: { borderColor: 'rgba(255, 125, 125, 0.35)' },
  cardTitle: { color: k.text, fontWeight: '800', fontSize: 15 },
  photoCard: { alignItems: 'center' },
  photoBadge: { position: 'absolute', right: -2, bottom: -2, width: 28, height: 28, borderRadius: 14, backgroundColor: k.cream, alignItems: 'center', justifyContent: 'center' },
  photoBadgeText: { color: k.backgroundDeep, fontWeight: '900' },
  photoActions: { flexDirection: 'row', gap: 8 },
  label: { color: k.textMuted, fontSize: 12, fontWeight: '700' },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: { borderWidth: 1, borderColor: k.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: k.text, backgroundColor: k.backgroundDeep },
  multiline: { minHeight: 84, textAlignVertical: 'top' },
  error: { color: k.danger, fontSize: 12 },
  muted: { color: k.textMuted, fontSize: 12.5, lineHeight: 18 },
  mutedCenter: { color: k.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', padding: 24 },
  small: { color: k.textMuted, fontSize: 11.5, lineHeight: 16 },
  segmented: { flexDirection: 'row', backgroundColor: k.backgroundDeep, borderRadius: 12, padding: 3 },
  segment: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  segmentActive: { backgroundColor: k.surfaceRaised },
  segmentText: { color: k.textMuted, fontWeight: '700' },
  segmentTextActive: { color: k.cream },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: k.backgroundDeep },
  inviteLink: { flex: 1, color: k.accent, fontSize: 12.5, fontFamily: 'monospace' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberRow: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: k.border },
  memberMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  memberName: { color: k.text, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 48 },
  chip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: k.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipDanger: { borderColor: 'rgba(255, 125, 125, 0.45)' },
  chipText: { color: k.cream, fontSize: 12, fontWeight: '800' },
  chipTextDanger: { color: k.danger },
  flex: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.45 },
});
