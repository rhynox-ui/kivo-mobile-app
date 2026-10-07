import type { KivoAddress, KivoGroup, KivoMessage, UserId } from './types';
import { MAX_POST_LENGTH } from './validation';
export type { UserId } from './types';

export type SocialPostId = string;
export type SocialPost = { id: SocialPostId; authorId: UserId; text: string; imageUri?: string; createdAt: number; likeCount: number; replyCount: number };
export type SocialReaction = { postId: SocialPostId; userId: UserId; type: 'like'; createdAt: number };
export type FollowRelation = { followerId: UserId; followingId: UserId; createdAt: number };
export type GroupMembership = { groupId: string; userId: UserId; role: 'admin' | 'member'; joinedAt: number };

export type CommunityRole = 'owner' | 'admin' | 'member';

export type ChannelAdmin = { channelId: ChannelId; userId: UserId; promotedAt: number; promotedBy: UserId };

export type ChannelVisibility = 'public' | 'private';
export type ChannelId = string;
export type Channel = {
  id: ChannelId;
  ownerId: UserId;
  name: string;
  description: string;
  visibility: ChannelVisibility;
  subscriberCount: number;
  postCount: number;
  createdAt: number;
  reputation: ChannelReputation;
  adminIds: UserId[];
};

export type ChannelPost = {
  id: string;
  channelId: ChannelId;
  authorId: UserId;
  text: string;
  imageUri?: string;
  createdAt: number;
  viewCount: number;
  reactionCount: number;
};

export type ChannelSubscription = { channelId: ChannelId; userId: UserId; createdAt: number; invitedByUserId?: UserId; referralCode?: string };
export type ChannelInvite = { channelId: ChannelId; inviterId: UserId; code: string; createdAt: number; uses: number; maxUses?: number };
export type ChannelContentType = 'alpha' | 'announcement' | 'discussion' | 'alert' | 'research' | 'education' | 'general';

export type ReputationTier = 'new' | 'rising' | 'established' | 'trusted' | 'notable' | 'elite';
export type ReputationSignals = {
  quality: number;
  consistency: number;
  engagement: number;
  retention: number;
  trust: number;
  growth: number;
  safetyPenalty: number;
};
export type ChannelReputation = {
  score: number;
  level: number;
  tier: ReputationTier;
  signals: ReputationSignals;
  updatedAt: number;
};

export type ReputationInput = {
  quality: number;
  consistency: number;
  engagementRate: number;
  retentionRate: number;
  reportsRate: number;
  followerGrowthRate: number;
  uniqueEngagers: number;
  views: number;
};

export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_AVATAR_BYTES = 300_000;
export const MAX_CHANNEL_NAME_LENGTH = 48;
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 280;
export const MAX_CHANNEL_SCORE = 1000;

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

export function validPostText(value: string): boolean {
  const text = value.normalize('NFC').trim();
  return text.length > 0 && text.length <= MAX_POST_LENGTH && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}
export function validPostMedia(uri: string | undefined): boolean { return uri == null || (uri.length > 0 && !/^data:/i.test(uri)); }
export function validChannelName(value: string): boolean {
  const text = value.normalize('NFC').trim();
  return text.length >= 2 && text.length <= MAX_CHANNEL_NAME_LENGTH && !/[\u0000-\u001F\u007F]/.test(text);
}
export function validChannelDescription(value: string): boolean {
  const text = value.normalize('NFC').trim();
  return text.length <= MAX_CHANNEL_DESCRIPTION_LENGTH && !/[\u0000-\u001F\u007F]/.test(text);
}
export function canFollow(actorId: UserId, targetId: UserId): boolean { return actorId.length > 0 && targetId.length > 0 && actorId !== targetId; }
export function canManageGroup(userId: UserId, group: KivoGroup): boolean { return group.ownerId === userId || group.adminIds.includes(userId); }
export function isGroupOwner(userId: UserId, group: KivoGroup): boolean { return group.ownerId === userId; }
export function canManageGroupMember(actorId: UserId, targetId: UserId, group: KivoGroup): boolean {
  if (!canManageGroup(actorId, group) || targetId === group.ownerId) return false;
  return group.ownerId === actorId || (group.adminIds.includes(actorId) && !group.adminIds.includes(targetId));
}
/** Only the owner promotes admins. A delegated admin can never mint another admin. */
export function canPromoteGroupAdmin(actorId: UserId, targetId: UserId, group: KivoGroup): boolean {
  return group.ownerId === actorId && targetId !== group.ownerId && !group.adminIds.includes(targetId);
}
/** Only the owner demotes admins; the owner itself is never an admin to demote. */
export function canDemoteGroupAdmin(actorId: UserId, targetId: UserId, group: KivoGroup): boolean {
  return group.ownerId === actorId && targetId !== group.ownerId && group.adminIds.includes(targetId);
}
export function groupRoleOf(userId: UserId, group: KivoGroup, isMember: boolean): CommunityRole | null {
  if (group.ownerId === userId) return 'owner';
  if (group.adminIds.includes(userId)) return 'admin';
  return isMember ? 'member' : null;
}
export function channelRoleOf(userId: UserId, channel: Channel, isSubscriber: boolean): CommunityRole | null {
  if (channel.ownerId === userId) return 'owner';
  if (channel.adminIds.includes(userId)) return 'admin';
  return isSubscriber ? 'member' : null;
}
export function canRemoveGroupMember(actorId: UserId, targetId: UserId, group: KivoGroup): boolean {
  return canManageGroupMember(actorId, targetId, group);
}
export function canEditMessage(userId: UserId, message: KivoMessage): boolean { return message.senderId === userId; }
export function canDeleteMessage(userId: UserId, message: KivoMessage, group?: KivoGroup): boolean { return message.senderId === userId || (group != null && canManageGroup(userId, group)); }
export function sameWallet(a: KivoAddress, b: KivoAddress): boolean { return a.trim().toLowerCase() === b.trim().toLowerCase(); }

/**
 * Reputation is deliberately based on useful behavior, not raw follower count.
 * This keeps growth from becoming a simple popularity-buying contest.
 */
export function calculateReputation(input: ReputationInput, previousScore = 0): ChannelReputation {
  const signals: ReputationSignals = {
    quality: clamp(input.quality),
    consistency: clamp(input.consistency),
    engagement: clamp(input.engagementRate * 100),
    retention: clamp(input.retentionRate * 100),
    trust: clamp(100 - input.reportsRate * 100),
    growth: clamp(input.followerGrowthRate * 100),
    safetyPenalty: clamp(input.reportsRate * 200),
  };

  const raw =
    signals.quality * 0.25 +
    signals.consistency * 0.15 +
    signals.engagement * 0.18 +
    signals.retention * 0.16 +
    signals.trust * 0.14 +
    signals.growth * 0.12;

  // Unique engagement and reach add diminishing returns; they cannot dominate quality.
  const reachBonus = Math.min(8, Math.log10(Math.max(1, input.uniqueEngagers)) * 2);
  const viewBonus = Math.min(5, Math.log10(Math.max(1, input.views)) * 1.25);
  const target = clamp(raw + reachBonus + viewBonus - signals.safetyPenalty, 0, 100) * 10;

  // Smooth the score and cap movement so one viral post or attack cannot rewrite reputation.
  const score = Math.round(Math.min(MAX_CHANNEL_SCORE, Math.max(0, previousScore * 0.85 + target * 0.15)));
  const level = Math.min(10, Math.floor(score / 100) + 1);
  const tier: ReputationTier =
    score < 100 ? 'new' :
    score < 250 ? 'rising' :
    score < 450 ? 'established' :
    score < 650 ? 'trusted' :
    score < 850 ? 'notable' : 'elite';

  return { score, level, tier, signals, updatedAt: Date.now() };
}

export function canManageChannel(userId: UserId, channel: Channel): boolean {
  return channel.ownerId === userId || channel.adminIds.includes(userId);
}
export function isChannelOwner(userId: UserId, channel: Channel): boolean { return channel.ownerId === userId; }
export function canManageChannelAdmin(actorId: UserId, targetId: UserId, channel: Channel): boolean {
  if (!canManageChannel(actorId, channel) || targetId === channel.ownerId) return false;
  return channel.ownerId === actorId || (channel.adminIds.includes(actorId) && !channel.adminIds.includes(targetId));
}
export function canPublishToChannel(userId: UserId, channel: Channel): boolean {
  return canManageChannel(userId, channel);
}
export function canViewChannel(userId: UserId | undefined, channel: Channel): boolean {
  return channel.visibility === 'public' || userId === channel.ownerId;
}


export function channelDiscoveryScore(
  channel: Channel,
  latestPostAt = channel.createdAt,
  now = Date.now(),
): number {
  const ageHours = Math.max(0, (now - latestPostAt) / 3_600_000);
  const freshness = Math.max(0, 1 - Math.min(1, ageHours / (24 * 7)));
  const reputation = channel.reputation.score / MAX_CHANNEL_SCORE;
  const growthSignal = Math.min(1, Math.log10(Math.max(1, channel.subscriberCount + 1)) / 6);
  const activitySignal = Math.min(1, channel.postCount / 100);
  return reputation * 0.5 + freshness * 0.25 + growthSignal * 0.15 + activitySignal * 0.1;
}
