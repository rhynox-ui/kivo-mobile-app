import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { isOfficialKivoChannel, type ApiCommunity, type ApiMember } from '@kivo/shared/api/types';
import { canDemoteGroupAdmin, canPromoteGroupAdmin, canRemoveGroupMember } from '@kivo/shared/social/rules';
import type { KivoGroup } from '@kivo/shared/social/types';
import { refreshConversations } from '@kivo/shared/chat/store';
import { getProfile } from '@kivo/shared/profile/store';
import { kivoTheme } from '../theme/kivoTheme';
import { api, socialReady } from '../state/session';
import { Avatar } from './ChatListScreen';

function memberName(member: ApiMember) {
  if (member.profile?.username) return '@' + member.profile.username;
  const address = member.userId.replace(/^kivo:/, '');
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Group/channel info: description, members/team and owner-controlled roles (same rules as web and the API). */
export function CommunityScreen({ id, onBack, onOpenChat, onOpenPerson }: { id: string; onBack: () => void; onOpenChat: (id: string) => void; onOpenPerson?: (userId: string) => void }) {
  const [data, setData] = useState<{ community: ApiCommunity; members: ApiMember[] } | null>(null);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [verificationPlan, setVerificationPlan] = useState<'monthly' | 'annual'>('annual');
  const [verificationChain, setVerificationChain] = useState<'ethereum' | 'base' | 'arbitrum' | 'solana'>('base');
  const [verificationHash, setVerificationHash] = useState('');
  const [verificationReceipt, setVerificationReceipt] = useState<any>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const load = useCallback(() => api.community(id).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Not available.')), [id]);
  useEffect(() => { void load(); }, [load]);

  const run = (action: () => Promise<unknown>, done?: () => void) => async () => {
    if (!socialReady()) { Alert.alert('Kivo', 'Turn on chats first (Chats tab).'); return; }
    try { await action(); await refreshConversations().catch(() => {}); done ? done() : void load(); }
    catch (e) { Alert.alert('Community', e instanceof Error ? e.message : 'Action failed.'); }
  };

  if (error) return <View style={styles.root}><Header title="Community" onBack={onBack} /><Text style={styles.muted}>{error}</Text></View>;
  if (!data) return <View style={styles.root}><Header title="Community" onBack={onBack} /><ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 40 }} /></View>;

  const { community: c, members } = data;
  const me = socialReady() ? getProfile().userId : null;
  const isChannel = c.kind === 'channel';
  const manager = c.myRole === 'owner' || c.myRole === 'admin';
  const group: KivoGroup = { id: c.id, name: c.name, ownerId: c.ownerId, adminIds: members.filter(m => m.role === 'admin').map(m => m.userId), memberCount: c.memberCount };

  return (
    <View style={styles.root}>
      <Header title={c.name} verified={Boolean(c.isVerified) || isOfficialKivoChannel(c.id)} onBack={onBack} onShare={() => Share.share({ message: `Join ${c.name} on Kivo: https://kivotrade.site/${c.kind}/${c.id}` })} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.hero}>
          <Avatar name={c.name} uri={c.avatarUrl} size={88} />
          <View style={styles.titleLine}><Text style={styles.title}>{c.name}</Text>{isChannel && (c.isVerified || c.id === 'ch_671d27c151fefc25c8e5') ? <Text accessibilityLabel="Verified official Kivo channel" style={styles.verifiedBadge}>★</Text> : null}</View>
          <Text style={styles.muted}>{c.visibility === 'private' ? 'Private' : 'Public'} {isChannel ? 'channel' : 'group'} · {c.memberCount} {isChannel ? 'subscribers' : 'members'} · {c.postCount} {isChannel ? 'posts' : 'messages'}</Text>
          {c.description ? <Text style={styles.description}>{c.description}</Text> : null}
          {c.myRole ? <Text style={styles.role}>{c.myRole.toUpperCase()}</Text> : null}
          {c.myRole
            ? <Pressable onPress={() => onOpenChat(c.id)} style={styles.primary}><Text style={styles.primaryText}>{isChannel ? 'Open channel' : 'Open chat'}</Text></Pressable>
            : <Pressable onPress={run(() => api.join(c.id), () => onOpenChat(c.id))} style={styles.primary}><Text style={styles.primaryText}>{c.visibility === 'private' ? 'Private' : isChannel ? 'Subscribe' : 'Join group'}</Text></Pressable>}
        </View>

        {isChannel && c.myRole === 'owner' && c.id !== 'ch_671d27c151fefc25c8e5' && <View style={styles.card}>
          <Text style={styles.cardTitle}>★ Blue Star verification</Text>
          <Text style={styles.muted}>$1 USDC / month or $5 USDC / year. Send exact USDC first, then submit the transaction hash.</Text>
          <Text style={styles.muted}>EVM: 0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5</Text>
          <Text style={styles.muted}>Solana: 2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki</Text>
          <View style={styles.verifyChoices}>{(['monthly', 'annual'] as const).map(p => <Pressable key={p} onPress={() => setVerificationPlan(p)} style={[styles.verifyChoice, verificationPlan === p && styles.verifyChoiceActive]}><Text style={styles.verifyChoiceText}>{p === 'monthly' ? '$1 / month' : '$5 / year'}</Text></Pressable>)}</View>
          <View style={styles.verifyChoices}>{(['base', 'ethereum', 'arbitrum', 'solana'] as const).map(n => <Pressable key={n} onPress={() => setVerificationChain(n)} style={[styles.verifyChoice, verificationChain === n && styles.verifyChoiceActive]}><Text style={styles.verifyChoiceText}>{n === 'base' ? 'Base' : n === 'ethereum' ? 'Ethereum' : n === 'arbitrum' ? 'Arbitrum' : 'Solana'}</Text></Pressable>)}</View>
          <TextInput value={verificationHash} onChangeText={setVerificationHash} autoCapitalize="none" autoCorrect={false} placeholder="Paste transaction hash" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
          <Pressable disabled={verificationBusy} onPress={async () => {
            if (!verificationHash.trim()) { Alert.alert('Verification', 'Paste the transaction hash first.'); return; }
            setVerificationBusy(true);
            try {
              const receipt = await api.purchaseVerification({subjectType: 'channel', subjectId: c.id, plan: verificationPlan, chain: verificationChain, txHash: verificationHash.trim()});
              setVerificationReceipt(receipt);
              Alert.alert('Payment confirmed', 'Blue Star verification is active. Your receipt is ready below.');
              void load();
            } catch (e) { Alert.alert('Payment not confirmed', e instanceof Error ? e.message : 'Could not verify payment.'); }
            finally { setVerificationBusy(false); }
          }} style={styles.primary}><Text style={styles.primaryText}>{verificationBusy ? 'Checking blockchain…' : 'Verify payment & activate'}</Text></Pressable>
          {verificationReceipt && <View style={styles.receipt}>
            <Text style={styles.cardTitle}>★ Kivo payment receipt</Text>
            <Text style={styles.receiptText}>Status: Paid & Verified</Text>
            <Text style={styles.receiptText}>Plan: {verificationReceipt.plan} · {verificationReceipt.amount} USDC</Text>
            <Text style={styles.receiptText}>Network: {verificationReceipt.chain}</Text>
            <Text style={styles.receiptText}>Transaction hash: {verificationReceipt.txHash}</Text>
            <Text style={styles.receiptText}>Paid to: {verificationReceipt.recipient}</Text>
            <Text style={styles.receiptText}>Paid: {new Date(verificationReceipt.paidAt).toLocaleString()}</Text>
            <Text style={styles.receiptText}>Valid until: {new Date(verificationReceipt.expiresAt).toLocaleDateString()}</Text>
            <Pressable style={styles.secondary} onPress={() => Share.share({message: `Kivo Verification Receipt\nStatus: Paid & Verified\nPlan: ${verificationReceipt.plan}\nAmount: ${verificationReceipt.amount} USDC\nNetwork: ${verificationReceipt.chain}\nTransaction: ${verificationReceipt.txHash}\nRecipient: ${verificationReceipt.recipient}\nValid until: ${new Date(verificationReceipt.expiresAt).toISOString()}\nExplorer: ${verificationReceipt.explorerUrl}`})}><Text style={styles.secondaryText}>Share receipt</Text></Pressable>
            <Pressable style={styles.secondary} onPress={() => Share.share({message: verificationReceipt.explorerUrl})}><Text style={styles.secondaryText}>View transaction: {verificationReceipt.explorerUrl}</Text></Pressable>
          </View>}
        </View>}
        {manager && <View style={styles.card}>
          <Text style={styles.cardTitle}>Add member</Text>
          <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} placeholder="0x… wallet address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} />
          <Pressable onPress={run(async () => { if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error('Enter a valid 0x wallet address.'); await api.addMember(c.id, address.trim()); setAddress(''); })} style={styles.secondary}><Text style={styles.secondaryText}>Add</Text></Pressable>
        </View>}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{isChannel && !manager ? 'Team' : 'Members'} · {members.length}</Text>
          {members.length === 0 ? <Text style={styles.muted}>{c.myRole ? 'No members to show.' : 'Join to see members.'}</Text> : members.map(member => {
            const target = member.userId;
            return (
              <View key={target} style={styles.memberRow}>
                <Pressable onPress={() => onOpenPerson?.(target)} style={styles.memberMain}>
                  <Avatar name={memberName(member)} uri={member.profile?.avatarUrl} size={38} />
                  <View style={styles.flex}><Text style={styles.memberName}>{memberName(member)}</Text><Text style={styles.small}>{member.role === 'owner' ? 'Owner · protected' : member.role === 'admin' ? 'Admin' : 'Member'}</Text></View>
                </Pressable>
                {me && canPromoteGroupAdmin(me, target, group) && <Pressable onPress={run(() => api.setAdmin(c.id, target, true))} style={styles.chip}><Text style={styles.chipText}>Make admin</Text></Pressable>}
                {me && canDemoteGroupAdmin(me, target, group) && <Pressable onPress={run(() => api.setAdmin(c.id, target, false))} style={styles.chip}><Text style={styles.chipText}>Remove admin</Text></Pressable>}
                {manager && member.role === 'member' && <Pressable onPress={run(() => api.setMemberRestricted(c.id, target, !member.restricted))} style={styles.chip}><Text style={styles.chipText}>{member.restricted ? 'Allow posting' : 'Restrict posting'}</Text></Pressable>}
                {me && canRemoveGroupMember(me, target, group) && <Pressable onPress={() => Alert.alert('Remove', `Remove ${memberName(member)}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: run(() => api.removeMember(c.id, target)) }])}><Text style={styles.danger}>Remove</Text></Pressable>}
              </View>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Permissions</Text>
          <Text style={styles.muted}>Owner: full control, cannot be removed or demoted. Only the owner promotes or demotes admins. {isChannel ? 'Owner and admins post; subscribers read.' : 'Admins add and remove regular members only.'} Admin is never ownership.</Text>
        </View>
        {c.myRole && c.myRole !== 'owner' && <Pressable onPress={run(() => api.leave(c.id), onBack)} style={styles.leave}><Text style={styles.danger}>{isChannel ? 'Unsubscribe' : 'Leave group'}</Text></Pressable>}
      </ScrollView>
    </View>
  );
}

function Header({ title, verified = false, onBack, onShare }: { title: string; verified?: boolean; onBack: () => void; onShare?: () => void }) {
  return <View style={styles.header}><Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><View style={styles.headerTitleLine}><Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>{verified ? <Text accessibilityLabel="Verified official Kivo channel" style={styles.verifiedBadge}>★</Text> : null}</View>{onShare ? <Pressable onPress={onShare}><Text style={styles.share}>Share</Text></Pressable> : <View />}</View>;
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  verifyChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginBottom: 6 },
  verifyChoice: { borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  verifyChoiceActive: { borderColor: kivoTheme.colors.accent, backgroundColor: kivoTheme.colors.surfaceElevated },
  verifyChoiceText: { color: kivoTheme.colors.text, fontSize: 13, fontWeight: '600' },
  receipt: { marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: kivoTheme.colors.surface },
  receiptText: { color: kivoTheme.colors.text, fontSize: 12, marginTop: 5 },

  root: { flex: 1, backgroundColor: c.background },
  header: { minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  back: { color: c.cream, fontSize: 36, width: 24 },
  headerTitleLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerTitle: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '800' },
  verifiedBadge: { overflow: 'hidden', color: '#2589F5', fontSize: 20, fontWeight: '900', textAlign: 'center', width: 20, height: 22 },
  share: { color: c.accent, fontWeight: '800' },
  body: { padding: 18, gap: 12, paddingBottom: 40 },
  hero: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  title: { color: c.text, fontSize: 24, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
  verifiedBadge: { overflow: 'hidden', color: '#2589F5', fontSize: 20, fontWeight: '900', textAlign: 'center', width: 20, height: 22 },
  description: { color: c.text, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  role: { color: c.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  muted: { color: c.textMuted, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  small: { color: c.textMuted, fontSize: 11.5 },
  primary: { marginTop: 6, alignSelf: 'stretch', height: 50, borderRadius: 25, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: c.backgroundDeep, fontWeight: '900' },
  card: { padding: 14, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, gap: 8 },
  cardTitle: { color: c.text, fontWeight: '800', fontSize: 15 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: c.text, backgroundColor: c.backgroundDeep },
  secondary: { height: 42, borderRadius: 21, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: c.cream, fontWeight: '800' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  memberName: { color: c.text, fontWeight: '700' },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: c.cream, fontSize: 11, fontWeight: '800' },
  danger: { color: c.danger, fontWeight: '800', fontSize: 12.5 },
  leave: { alignItems: 'center', padding: 14 },
});
