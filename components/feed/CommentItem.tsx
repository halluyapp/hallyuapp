import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, space } from '../../constants/theme';
import { timeAgo } from '../../lib/format';
import { useApp, useRequireMember } from '../../lib/hooks';
import { Comment, Post } from '../../lib/model';
import { Avatar } from '../ui/Avatar';
import { Sheet, SheetRow } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { ReactionButton } from './Reactions';
import { RichText } from './RichText';
import { SpoilerBlock, SpoilerTag } from './SpoilerBlock';
import { VerificationSeal } from '../recognition/VerificationSeal';

interface CommentItemProps {
  comment: Comment;
  post: Post;
  isReply?: boolean;
  onReply: (c: Comment) => void;
  highlighted?: boolean;
  replyCount?: number;
  onOpenThread?: () => void;
}

/** One level of threading: replies indent once; reply-to-reply uses an @mention. */
function CommentItemBase({ comment, post, isReply, onReply, highlighted, replyCount, onOpenThread }: CommentItemProps) {
  const router = useRouter();
  const { getUser, getDrama, isCommentVeiled, dispatch, me } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const author = getUser(comment.authorId);
  const replyTo = comment.replyToUserId ? getUser(comment.replyToUserId) : undefined;
  const drama = getDrama(post.context.dramaId);
  const veiled = isCommentVeiled(comment, post);
  const isMine = comment.authorId === me.id;
  const isOP = comment.authorId === post.authorId;

  if (comment.state === 'deleted') {
    return (
      <View style={[styles.row, isReply ? styles.reply : null]}>
        <View style={{ width: isReply ? 28 : 36 }} />
        <Text variant="bodySmall" tone="tertiary">
          This comment was deleted.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Pressable onLongPress={() => setMenu(true)} delayLongPress={350} style={[styles.row, isReply ? styles.reply : null, highlighted ? styles.highlight : null]} accessibilityLabel={`Comment by ${author?.displayName}`}>
        <Pressable onPress={() => author && router.push(`/user/${author.handle}`)} accessibilityRole="link" accessibilityLabel={`${author?.displayName} profile`}>
          <Avatar uri={author?.avatarUrl} name={author?.displayName ?? '?'} size={isReply ? 28 : 36} />
        </Pressable>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={styles.meta}>
            <Pressable onPress={() => author && router.push(`/user/${author.handle}`)} hitSlop={4} accessibilityRole="link">
              <Text variant="label" numberOfLines={1}>
                {author?.displayName}
              </Text>
            </Pressable>
            <VerificationSeal tier={author?.verificationTier} verified={author?.verified} size={13} />
            {isOP ? (
              <View style={styles.op}>
                <Text variant="caption" tone="accent" style={{ fontSize: 10, lineHeight: 12 }}>
                  OP
                </Text>
              </View>
            ) : null}
            <Text variant="caption" tone="tertiary">
              {timeAgo(comment.createdAt)}
            </Text>
            <SpoilerTag level={comment.spoiler} compact />
          </View>
          <SpoilerBlock id={comment.id} level={comment.spoiler} drama={drama} season={post.context.season} episode={post.context.episode} veiled={veiled} compact>
            <Text variant="bodySmall">
              {replyTo ? (
                <Text variant="bodySmall" tone="accent" onPress={() => router.push(`/user/${replyTo.handle}`)}>
                  @{replyTo.handle}{' '}
                </Text>
              ) : null}
              <RichText text={comment.body} variant="bodySmall" />
            </Text>
          </SpoilerBlock>
          <View style={styles.actions}>
            <ReactionButton targetId={comment.id} counts={comment.reactions} isComment compactMode />
            <Pressable onPress={() => require('reply to comments', () => onReply(comment))} hitSlop={8} accessibilityRole="button" accessibilityLabel="Reply">
              <Text variant="caption" tone="secondary">
                Reply
              </Text>
            </Pressable>
            {replyCount && onOpenThread ? (
              <Pressable onPress={onOpenThread} hitSlop={8} accessibilityRole="button" accessibilityLabel={`View ${replyCount} replies`}>
                <Text variant="caption" tone="accent">
                  {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                </Text>
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setMenu(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Comment options">
              <Ionicons name="ellipsis-horizontal" size={16} color={colors.textTertiary} />
            </Pressable>
          </View>
        </View>
      </Pressable>
      <Sheet visible={menu} onClose={() => setMenu(false)} title={`Comment by ${author?.displayName ?? 'member'}`}>
        <SheetRow icon="arrow-undo-outline" label="Reply" onPress={() => { setMenu(false); require('reply to comments', () => onReply(comment)); }} />
        <SheetRow
          icon="link-outline"
          label="Copy link"
          onPress={async () => {
            setMenu(false);
            await Clipboard.setStringAsync(`https://hallyu.app/p/${post.id}?commentId=${comment.id}`).catch(() => {});
            toast.show('Link copied');
          }}
        />
        {isMine ? (
          <SheetRow icon="trash-outline" label="Delete" tone="danger" onPress={() => { setMenu(false); dispatch({ type: 'deleteComment', id: comment.id }); toast.show('Comment deleted'); }} />
        ) : (
          <>
            <SheetRow icon="flag-outline" label="Report" onPress={() => { setMenu(false); router.push({ pathname: '/report', params: { targetId: comment.id, kind: 'comment' } }); }} />
            <SheetRow icon="ban-outline" label={`Block @${author?.handle}`} tone="danger" onPress={() => require('block people', () => { setMenu(false); dispatch({ type: 'block', userId: comment.authorId, on: true }); toast.show({ message: `Blocked @${author?.handle}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'block', userId: comment.authorId, on: false }) }); })} />
          </>
        )}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.x3, paddingHorizontal: space.margin, paddingVertical: space.x3 },
  reply: { paddingLeft: space.margin + 36 + space.x3 },
  highlight: { backgroundColor: colors.accentSoft },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  op: { backgroundColor: colors.accentSoft, paddingHorizontal: 5, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.x4, marginTop: 2 },
});

/** Memoised: with tracked store getters, a card re-renders only when its own data changes. */
export const CommentItem = React.memo(CommentItemBase);
