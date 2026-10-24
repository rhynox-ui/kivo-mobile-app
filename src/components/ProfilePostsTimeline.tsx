import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { FeedPost } from '@kivo/shared/api/client';
import { api } from '../state/session';
import { kivoTheme } from '../theme/kivoTheme';

import { userHandle, userPlainName } from '@kivo/shared/profile/userLabel';
const c = kivoTheme.colors;
const PAGE_SIZE = 30;

function formatPostDate(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

/** Shared chronological author timeline for own and public mobile profiles. */
export function ProfilePostsTimeline({userId}: {userId: string}) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (append: boolean) => {
    if (append ? loadingMore : loading) return;
    append ? setLoadingMore(true) : setLoading(true);
    setError(false);
    try {
      const rows = await api.profileFeedPosts(userId, append ? cursor : undefined);
      setPosts(current => append ? [...current, ...rows.filter(row => !current.some(item => item.id === row.id))] : rows);
      setCursor(rows.length ? (rows[rows.length - 1].nextCursor ?? rows[rows.length - 1].id) : append ? cursor : undefined);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [cursor, loading, loadingMore, userId]);

  useEffect(() => {
    setPosts([]);
    setCursor(undefined);
    setHasMore(false);
    setLoading(true);
    setError(false);
    let active = true;
    api.profileFeedPosts(userId).then(rows => {
      if (!active) return;
      setPosts(rows);
      setCursor(rows.length ? (rows[rows.length - 1].nextCursor ?? rows[rows.length - 1].id) : undefined);
      setHasMore(rows.length === PAGE_SIZE);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Posts</Text>
      {loading && posts.length === 0 ? <View style={styles.status}><ActivityIndicator color={c.cream} /><Text style={styles.muted}>Loading posts…</Text></View> : null}
      {error && posts.length === 0 ? (
        <View style={styles.status}><Text style={styles.muted}>Could not load posts.</Text><Pressable onPress={() => { setLoading(false); void load(false); }} style={styles.smallButton}><Text style={styles.buttonText}>Try again</Text></Pressable></View>
      ) : null}
      {!loading && !error && posts.length === 0 ? <Text style={styles.muted}>No posts yet. Posts shared by this member will appear here.</Text> : null}
      {posts.map(post => (
        <View key={post.id} style={styles.post}>
          <View style={styles.postHead}>
            <View style={styles.avatar}>{post.avatarUrl ? <Image source={{uri: post.avatarUrl}} style={styles.avatarImage} /> : <Text style={styles.avatarLetter}>{userPlainName(post.hasUsername === false ? null : post.username, post.userId, 'K').slice(0, 1).toUpperCase()}</Text>}</View>
            <View style={styles.authorBlock}>
              <Text style={styles.author} numberOfLines={1}>{userHandle(post.hasUsername === false ? null : post.username, post.userId)}</Text>
              <Text style={styles.date}>{formatPostDate(post.createdAt)}</Text>
            </View>
          </View>
          {post.body ? <Text selectable style={styles.bodyText}>{post.body}</Text> : null}
          {post.imageUrl ? <Image source={{uri: post.imageUrl}} style={styles.postImage} resizeMode="cover" /> : null}
          {post.token ? (
            <View style={styles.token}>
              {post.token.imageUrl ? <Image source={{uri: post.token.imageUrl}} style={styles.tokenImage} /> : <View style={styles.tokenFallback}><Text style={styles.tokenFallbackText}>$</Text></View>}
              <View style={styles.authorBlock}>
                <Text style={styles.tokenName} numberOfLines={1}>{post.token.name || post.token.symbol}</Text>
                <Text style={styles.muted} numberOfLines={1}>{post.token.symbol} · {post.token.chain}</Text>
              </View>
              {post.token.entryMarketCapUsd != null ? <Text style={styles.muted}>Entry MC ${post.token.entryMarketCapUsd.toLocaleString()}</Text> : null}
            </View>
          ) : null}
          {post.pollId ? <Text style={styles.pollTag}>Poll · Open the Feed to vote</Text> : null}
          <View style={styles.actions}>
            <Text style={styles.actionText}>♡ {post.likeCount} Like</Text>
            <Text style={styles.actionText}>◇ {post.dislikeCount} Dislike</Text>
            <Text style={styles.actionText}>▢ {post.replyCount} Comment</Text>
          </View>
        </View>
      ))}
      {hasMore ? <Pressable disabled={loadingMore} onPress={() => void load(true)} style={styles.moreButton}>{loadingMore ? <ActivityIndicator color={c.cream} /> : <Text style={styles.buttonText}>Load more posts</Text>}</Pressable> : null}
      {error && posts.length > 0 ? <Pressable onPress={() => { setLoadingMore(false); void load(true); }} style={styles.moreButton}><Text style={styles.buttonText}>Retry loading more</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {alignSelf: 'stretch', gap: 10, marginTop: 16},
  title: {color: c.text, fontSize: 19, fontWeight: '900', marginBottom: 2},
  post: {backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 18, padding: 14, gap: 10},
  postHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  avatar: {width: 42, height: 42, borderRadius: 21, backgroundColor: c.surfaceRaised, overflow: 'hidden', alignItems: 'center', justifyContent: 'center'},
  avatarImage: {width: '100%', height: '100%'},
  avatarLetter: {color: c.cream, fontSize: 17, fontWeight: '900'},
  authorBlock: {flex: 1, minWidth: 0, gap: 3},
  author: {color: c.text, fontWeight: '900', fontSize: 14},
  date: {color: c.textMuted, fontSize: 11},
  bodyText: {color: c.text, fontSize: 15, lineHeight: 21},
  postImage: {width: '100%', height: 220, borderRadius: 12, backgroundColor: c.surfaceRaised},
  token: {flexDirection: 'row', alignItems: 'center', gap: 9, padding: 10, borderRadius: 12, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border},
  tokenImage: {width: 34, height: 34, borderRadius: 17},
  tokenFallback: {width: 34, height: 34, borderRadius: 17, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center'},
  tokenFallbackText: {color: c.cream, fontWeight: '900'},
  tokenName: {color: c.text, fontWeight: '800'},
  pollTag: {color: c.cream, fontSize: 12, fontWeight: '800'},
  actions: {borderTopWidth: 1, borderTopColor: c.border, paddingTop: 9, flexDirection: 'row', flexWrap: 'wrap', gap: 14},
  actionText: {color: c.textMuted, fontSize: 11.5},
  muted: {color: c.textMuted, fontSize: 12},
  status: {padding: 14, borderRadius: 14, backgroundColor: c.surface, alignItems: 'center', gap: 8},
  smallButton: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: c.surfaceRaised},
  moreButton: {minHeight: 42, borderRadius: 22, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10},
  buttonText: {color: c.text, fontWeight: '800'},
});
