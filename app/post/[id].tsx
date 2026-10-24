import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommentItem } from '../../components/feed/CommentItem';
import { PostCard } from '../../components/feed/PostCard';
import { SpoilerTag } from '../../components/feed/SpoilerBlock';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Screen, useColumn } from '../../components/ui/Screen';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../constants/theme';
import { supabase } from '../../lib/api/client';
import { useAuth } from '../../lib/auth';
import { extractMentions, uid } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { Comment, emptyReactions, LIMITS, SpoilerLevel } from '../../lib/model';
import { commentsFor } from '../../lib/selectors';
import { SPOILER_LABEL } from '../../lib/spoiler';
import { getState } from '../../lib/store';
import { adoptLocal, adoptPostThread } from '../../lib/sync';
import { track } from '../../lib/analytics';

type Sort = 'top' | 'newest' | 'oldest';
type Row = { key: string; comment: Comment; isReply: boolean; replyCount: number };

/** Post detail — the full post, then one-level threaded comments with a sticky composer. */
export default function PostDetail() {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const column = useColumn();
  const { id, commentId, focus } = useLocalSearchParams<{ id: string; commentId?: string; focus?: string }>();
  const { state, dispatch, getPost, getUser, me } = useApp();
  const require = useRequireMember();
  const post = getPost(id);
  const [sort, setSort] = useState<Sort>('top');
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [spoiler, setSpoiler] = useState<SpoilerLevel>('none');
  const [spoilerSheet, setSpoilerSheet] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hydrating, setHydrating] = useState<boolean>(() => Boolean(!post && supabase && id));
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Row>>(null);

  useEffect(() => {
    if (!id || !supabase) return;
    let alive = true;
    setHydrating(!post);
    void adoptPostThread(id, {
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
      addPosts: (posts) => {
        for (const p of posts) adoptLocal({ type: 'addPost', post: p });
      },
    }).finally(() => {
      if (alive) setHydrating(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const comments = useMemo(() => (post ? commentsFor(state, post.id) : []), [state, post]);
  const rows = useMemo<Row[]>(() => {
    const top = comments.filter((c) => !c.parentId);
    const score = (c: Comment) => Object.values(c.reactions).reduce((a, b) => a + b, 0) + comments.filter((r) => r.parentId === c.id).length * 2;
    const sorted = sort === 'top' ? [...top].sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt)) : sort === 'newest' ? [...top].reverse() : top;
    const out: Row[] = [];
    for (const c of sorted) {
      const replies = comments.filter((r) => r.parentId === c.id);
      out.push({ key: c.id, comment: c, isReply: false, replyCount: replies.length });
      if (!collapsed[c.id]) for (const r of replies) out.push({ key: r.id, comment: r, isReply: true, replyCount: 0 });
    }
    return out;
  }, [comments, sort, collapsed]);

  useEffect(() => {
    if (focus === 'comment') setTimeout(() => inputRef.current?.focus(), 350);
  }, [focus]);
  useEffect(() => {
    if (commentId && rows.length) {
      const idx = rows.findIndex((r) => r.key === commentId);
      if (idx >= 0) setTimeout(() => listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 }), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentId, rows.length]);

  if (!post && hydrating) {
    return (
      <Screen header={<TopBar mode="stack" title="Post" />}>
        <ListSkeleton rows={4} />
      </Screen>
    );
  }

  if (!post || post.state === 'deleted') {
    return (
      <Screen header={<TopBar mode="stack" title="Post" />}>
        <ErrorState kind="notFound" title={post ? 'This post was deleted' : 'Post unavailable'} body={post ? 'The author removed it. Replies are gone with it.' : 'It may have been removed, or the link is wrong.'} onRetry={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} />
      </Screen>
    );
  }
  if (state.blockedUsers.includes(post.authorId)) {
    return (
      <Screen header={<TopBar mode="stack" title="Post" />}>
        <EmptyState icon="ban-outline" title="From someone you blocked" body="Unblock them from their profile to see this post." actionLabel="Open profile" onAction={() => router.push(`/user/${getUser(post.authorId)?.handle}`)} />
      </Screen>
    );
  }

  const remaining = LIMITS.comment - text.length;
  const mentionQuery = (() => {
    const m = /(?:^|\s)@(\w*)$/.exec(text);
    return m ? m[1]!.toLowerCase() : null;
  })();
  const mentionMatches = mentionQuery !== null ? Object.values(state.users).filter((u) => u.id !== me.id && (u.handle.toLowerCase().startsWith(mentionQuery) || u.displayName.toLowerCase().includes(mentionQuery))).slice(0, 4) : [];

  const submit = () =>
    require('comment', () => {
      const body = text.trim();
      if (!body) return;
      const mentions = extractMentions(body).map((h) => Object.values(state.users).find((u) => u.handle.toLowerCase() === h.toLowerCase())?.id).filter(Boolean) as string[];
      const comment: Comment = { id: uid('c'), postId: post.id, authorId: me.id, parentId: replyTo ? replyTo.parentId ?? replyTo.id : undefined, replyToUserId: replyTo?.authorId, body, createdAt: new Date().toISOString(), spoiler, reactions: emptyReactions(), state: 'active' };
      void mentions;
      dispatch({ type: 'addComment', comment });
      track('comment.add', { reply: !!replyTo, spoiler });
      haptic.success();
      setText('');
      setReplyTo(null);
      setSpoiler('none');
      Keyboard.dismiss();
      toast.show({ message: replyTo ? 'Reply posted' : 'Comment posted', icon: 'checkmark-circle', tone: 'success' });
    });

  const startReply = (c: Comment) => {
    require('reply', () => {
      setReplyTo(c);
      if (c.spoiler !== 'none' && spoiler === 'none') setSpoiler(c.spoiler);
      setTimeout(() => inputRef.current?.focus(), 50);
    });
  };

  const header = (
    <View>
      <PostCard post={post} detail />
      <View style={styles.commentsHead}>
        <Text variant="titleSmall">
          {comments.length ? `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}` : 'Comments'}
        </Text>
        <Segmented variant="pill" items={[{ key: 'top', label: 'Top' }, { key: 'newest', label: 'New' }, { key: 'oldest', label: 'Old' }]} value={sort} onChange={setSort} style={{ width: 200 }} />
      </View>
      {post.spoiler !== 'none' ? (
        <View style={{ paddingHorizontal: space.margin, paddingBottom: space.x2 }}>
          <Text variant="caption" tone="secondary">
            Marked “{SPOILER_LABEL[post.spoiler]}” — comments here can discuss it freely.
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen header={<TopBar mode="stack" title={post.type === 'discussion' ? 'Discussion' : post.type === 'review' ? 'Review' : 'Post'} subtitle={getUser(post.authorId) ? `@${getUser(post.authorId)!.handle}` : undefined} />}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 56}>
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(r) => r.key}
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={[{ paddingBottom: space.x6 }, column]}
          onScrollToIndexFailed={() => {}}
          renderItem={({ item: r }) => <CommentItem comment={r.comment} post={post} isReply={r.isReply} onReply={startReply} highlighted={r.key === commentId} replyCount={r.replyCount} onOpenThread={r.replyCount ? () => setCollapsed((c) => ({ ...c, [r.key]: !c[r.key] })) : undefined} />}
          ListEmptyComponent={<EmptyState compact icon="chatbubble-ellipses-outline" title="No comments yet" body={post.type === 'discussion' ? 'The author asked a question. Answer it.' : 'Be first. Kind, specific, spoiler-tagged if it needs it.'} actionLabel="Write a comment" onAction={() => require('comment', () => inputRef.current?.focus())} />}
        />
        {auth.status !== 'signedIn' ? (
          <Pressable onPress={() => require('comment', () => {})} style={[styles.composer, { paddingBottom: insets.bottom + space.x2, flexDirection: 'row', alignItems: 'center', gap: space.x3 }]} accessibilityRole="button" accessibilityLabel="Sign in to comment">
            <Text variant="body" tone="tertiary" style={{ flex: 1 }}>
              Sign in to join the conversation
            </Text>
            <Button label="Sign in" size="sm" onPress={() => require('comment', () => {})} />
          </Pressable>
        ) : (
          <View style={[styles.composer, { paddingBottom: insets.bottom + space.x2 }]}>
            {mentionMatches.length ? (
              <View style={styles.mentions}>
                {mentionMatches.map((u) => (
                  <Pressable key={u.id} onPress={() => setText((t) => t.replace(/@(\w*)$/, `@${u.handle} `))} style={styles.mentionRow} accessibilityRole="button" accessibilityLabel={`Mention ${u.displayName}`}>
                    <Avatar uri={u.avatarUrl} name={u.displayName} size="xs" />
                    <Text variant="label">{u.displayName}</Text>
                    <Text variant="caption" tone="secondary">
                      @{u.handle}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {replyTo ? (
              <View style={styles.replyBar}>
                <Ionicons name="arrow-undo-outline" size={14} color={colors.textSecondary} />
                <Text variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
                  Replying to {getUser(replyTo.authorId)?.displayName}: {replyTo.body}
                </Text>
                <Pressable onPress={() => setReplyTo(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel reply">
                  <Ionicons name="close" size={16} color={colors.textSecondary} />
                </Pressable>
              </View>
            ) : null}
            <View style={styles.inputRow}>
              <Avatar uri={me.avatarUrl} name={me.displayName} size="sm" />
              <TextInput ref={inputRef} value={text} onChangeText={(t) => setText(t.slice(0, LIMITS.comment))} placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'} placeholderTextColor={colors.textTertiary} multiline style={styles.input} selectionColor={colors.accent} cursorColor={colors.accent} keyboardAppearance="dark" accessibilityLabel="Comment" />
              <Pressable onPress={() => setSpoilerSheet(true)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Spoiler level: ${SPOILER_LABEL[spoiler]}`}>
                {spoiler === 'none' ? <Ionicons name="eye-off-outline" size={20} color={colors.textTertiary} /> : <SpoilerTag level={spoiler} compact />}
              </Pressable>
              <Pressable onPress={submit} disabled={!text.trim()} style={[styles.send, !text.trim() ? { opacity: 0.4 } : null]} accessibilityRole="button" accessibilityLabel="Post comment">
                <Ionicons name="arrow-up" size={18} color={colors.onAccent} />
              </Pressable>
            </View>
            {remaining < 100 ? (
              <Text variant="caption" tone={remaining < 0 ? 'danger' : 'tertiary'} align="right" numeric>
                {remaining}
              </Text>
            ) : null}
          </View>
        )}
      </KeyboardAvoidingView>
      <Sheet visible={spoilerSheet} onClose={() => setSpoilerSheet(false)} title="Spoiler level for this comment" subtitle="Veiled for anyone who hasn’t reached that point.">
        <ChipRow style={{ padding: space.x4 }}>
          {(['none', 'episode', 'season', 'ending'] as SpoilerLevel[]).map((l) => (
            <Chip key={l} label={SPOILER_LABEL[l]} selected={spoiler === l} onPress={() => { setSpoiler(l); setSpoilerSheet(false); }} />
          ))}
        </ChipRow>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  commentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.margin, paddingVertical: space.x3, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  composer: { borderTopWidth: 1, borderTopColor: colors.borderSubtle, backgroundColor: colors.canvas, paddingHorizontal: space.margin, paddingTop: space.x2, flexDirection: 'column' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.x2 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: space.x3, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.surface1, color: colors.textPrimary, fontFamily: fonts.regular, fontSize: 15, lineHeight: 20 },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  replyBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  mentions: { backgroundColor: colors.surface2, borderRadius: radius.md, marginBottom: space.x2, overflow: 'hidden' },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingHorizontal: space.x3, height: 40 },
});
