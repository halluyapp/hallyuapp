import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { aspect, colors, radius, space } from '../../constants/theme';
import { dramaLabel } from '../../lib/fandoms';
import { compact, seasonEpisodeLabel, timeAgo } from '../../lib/format';
import { haptic, useApp, useLayout, useRequireMember } from '../../lib/hooks';
import { DiscussionKind, Post } from '../../lib/model';
import { Avatar } from '../ui/Avatar';
import { Poster } from '../ui/Poster';
import { Sheet, SheetRow } from '../ui/Sheet';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { ReactionButton, ReactionSummary } from './Reactions';
import { PollBlock } from './PollBlock';
import { ShareCardModal } from '../share/ShareCardModal';
import { FeedVideo } from '../media/FeedVideo';
import { ImageCarousel } from '../media/ImageCarousel';
import { SpoilerBlock, SpoilerTag } from './SpoilerBlock';
import { RichText } from './RichText';
import * as Clipboard from 'expo-clipboard';
import { localDone, saveImage, saveVideo, MediaError } from '../../lib/media';
import { videoUrl } from '../../lib/video';

export const KIND_LABEL: Record<DiscussionKind, string> = { general: 'Discussion', theory: 'Theory', ending: 'Ending talk', character: 'Character', scene: 'Scene', question: 'Question' };
export const TYPE_LABEL: Record<Post['type'], string> = { post: 'Post', reaction: 'Reaction', discussion: 'Discussion', review: 'Review', recommendation: 'Recommendation', short: 'Short' };

interface PostCardProps {
  post: Post;
  reason?: string;
  detail?: boolean; // full body, no truncation, larger type
  hideContext?: boolean; // when already inside the drama/episode
  style?: StyleProp<ViewStyle>;
  onOpenComments?: () => void;
}

/**
 * One card for all post types. The chassis is constant (author → context → body → media → actions);
 * the body slot adapts per type (reaction = large quote, discussion = title + kind, review = rating +
 * verdict, recommendation = "if you liked" pairing).
 */
function PostCardBase({ post, reason, detail, hideContext, style, onOpenComments }: PostCardProps) {
  const router = useRouter();
  const { getUser, getDrama, getActor, isPostVeiled, isSaved, watch, dispatch, me } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const { width, margin } = useLayout();
  const [menu, setMenu] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePct, setSavePct] = useState(0);
  const [toDevice, setToDevice] = useState(false);
  const author = getUser(post.authorId);
  const drama = getDrama(post.context.dramaId);
  const secondary = getDrama(post.context.secondaryDramaId);
  const veiled = isPostVeiled(post);
  const saved = isSaved(post.id);
  const isMine = post.authorId === me.id;
  const epLabel = seasonEpisodeLabel(post.context.season, post.context.episode, drama?.seasons.length);
  const imageW = Math.min(width - margin * 2, 640);

  const open = () => router.push(`/post/${post.id}`);
  const share = () => {
    haptic.light();
    setShareOpen(true);
  };
  const save = () =>
    require('save posts', () => {
      haptic.light();
      dispatch({ type: 'save', postId: post.id });
      toast.show({ message: saved ? 'Removed from Saved' : 'Saved', icon: saved ? 'bookmark-outline' : 'bookmark', actionLabel: saved ? undefined : 'View', onAction: () => router.push('/saved') });
    });

  const mediaKey = post.video?.key ?? (typeof post.images?.[0] === 'string' ? (post.images[0] as string) : undefined);

  // Reflect whether this member already has the media on this device.
  useEffect(() => {
    if (!mediaKey) return;
    localDone(mediaKey).then(setToDevice).catch(() => {});
  }, [mediaKey]);

  const download = async () => {
    require('download media', async () => {
      haptic.light();
      if (saving) return;
      setSaving(true);
      setSavePct(0);
      try {
        if (post.video && post.video.key) {
          const url = post.video.url.startsWith('http') ? post.video.url : videoUrl(post.video.url);
          const res = await saveVideo({ key: post.video.key, url, postId: post.id, onProgress: (p) => setSavePct(p.percent) });
          setToDevice(true);
          toast.show({ message: res.already ? 'Already on your device' : 'Video saved to your device', icon: 'download-outline', tone: 'success' });
        } else if (post.video) {
          // Remote URL with no ledger key: still downloadable, deduped by URL.
          const res = await saveVideo({ key: post.video.url, url: post.video.url, postId: post.id, onProgress: (p) => setSavePct(p.percent) });
          setToDevice(true);
          toast.show({ message: res.already ? 'Already on your device' : 'Video saved to your device', icon: 'download-outline', tone: 'success' });
        } else if (post.images?.length) {
          const first = post.images.find((i): i is string => typeof i === 'string');
          if (first) {
            const res = await saveImage(first, first);
            setToDevice(true);
            toast.show({ message: res.already ? 'Already in your photos' : 'Image saved to your photos', icon: 'download-outline', tone: 'success' });
          }
        }
      } catch (e) {
        if (e instanceof MediaError && e.message.toLowerCase().includes('permission')) {
          toast.show({ message: 'Storage permission denied', icon: 'lock-closed-outline', tone: 'danger' });
        } else {
          toast.show({ message: 'Download failed — try again', icon: 'cloud-offline-outline', tone: 'danger' });
        }
      } finally {
        setSaving(false);
      }
    });
  };

  const actors = useMemo(() => (post.context.actorIds ?? []).map((a) => getActor(a)).filter(Boolean), [post.context.actorIds, getActor]);

  if (post.state === 'deleted') {
    return (
      <View style={[styles.card, styles.tombstone, style]}>
        <Ionicons name="trash-outline" size={16} color={colors.textTertiary} />
        <Text variant="bodySmall" tone="tertiary">
          This post was deleted by its author.
        </Text>
      </View>
    );
  }

  const Body = (
    <View style={{ gap: space.x2 }}>
      {post.type === 'discussion' ? (
        <>
          <View style={styles.kindRow}>
            <Text variant="overline" tone="accent">
              {KIND_LABEL[post.kind ?? 'general']}
            </Text>
          </View>
          <Text variant={detail ? 'headline' : 'title'}>{post.title}</Text>
          <RichText text={post.body} variant={detail ? 'bodyLarge' : 'body'} numberOfLines={detail ? undefined : 6} tone="secondary" />
        </>
      ) : post.type === 'review' ? (
        <View style={{ gap: space.x3 }}>
          <View style={styles.reviewShowcase}>
            {drama ? (
              <Pressable onPress={() => router.push(`/drama/${drama.id}`)} accessibilityRole="link" accessibilityLabel={drama.title}>
                <Poster drama={drama} width={60} rounded={radius.sm} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                <View style={styles.ratingBox}>
                  <Ionicons name="star" size={14} color={colors.warm} />
                  <Text variant="titleSmall" style={{ color: colors.warm }} numeric>
                    {post.rating}
                  </Text>
                  <Text variant="caption" style={{ color: colors.warm, opacity: 0.78 }}>
                    /10
                  </Text>
                </View>
                <Text variant="overline" tone="tertiary">
                  VERDICT
                </Text>
              </View>
              <Text variant={detail ? 'titleLarge' : 'title'} style={{ lineHeight: 22 }}>
                {post.verdict}
              </Text>
            </View>
          </View>
          {post.body ? <RichText text={post.body} variant={detail ? 'bodyLarge' : 'body'} numberOfLines={detail ? undefined : 6} tone="secondary" /> : null}
        </View>
      ) : post.type === 'recommendation' ? (
        <View style={{ gap: space.x3 }}>
          {drama && secondary ? (
            <View style={styles.recPairCard}>
              <Pressable onPress={() => router.push(`/drama/${secondary.id}`)} style={styles.recCol} accessibilityRole="link" accessibilityLabel={`If you liked ${secondary.title}`}>
                <Text variant="overline" tone="tertiary">
                  IF YOU LOVED
                </Text>
                <Poster drama={secondary} width={66} rounded={radius.sm} />
                <Text variant="caption" numberOfLines={1} style={{ textAlign: 'center', maxWidth: 96 }}>
                  {secondary.title}
                </Text>
              </Pressable>
              <View style={styles.recArrow}>
                <Ionicons name="arrow-forward" size={18} color={colors.accent} />
              </View>
              <Pressable onPress={() => router.push(`/drama/${drama.id}`)} style={styles.recCol} accessibilityRole="link" accessibilityLabel={`Watch next: ${drama.title}`}>
                <Text variant="overline" tone="accent">
                  WATCH NEXT
                </Text>
                <Poster drama={drama} width={66} rounded={radius.sm} />
                <Text variant="caption" numberOfLines={1} style={{ textAlign: 'center', maxWidth: 96 }}>
                  {drama.title}
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  require('save to watchlist', () => {
                    haptic.light();
                    const inList = Boolean(watch(drama.id));
                    dispatch({ type: 'watch', dramaId: drama.id, status: inList ? null : 'want' });
                    toast.show({ message: inList ? `Removed ${drama.title}` : `Saved ${drama.title} to Watchlist`, icon: 'bookmark' });
                  })
                }
                style={[styles.recSaveBtn, watch(drama.id) ? styles.recSaveBtnOn : null]}
                accessibilityRole="button"
                accessibilityLabel={`Save ${drama.title} to watchlist`}
              >
                <Ionicons
                  name={watch(drama.id) ? 'checkmark' : 'add'}
                  size={16}
                  color={watch(drama.id) ? colors.onAccent : colors.textPrimary}
                />
              </Pressable>
            </View>
          ) : secondary ? (
            <Pressable onPress={() => router.push(`/drama/${secondary.id}`)} hitSlop={4} accessibilityRole="link" accessibilityLabel={`If you liked ${secondary.title}`}>
              <Text variant="caption" tone="secondary">
                If you liked{' '}
                <Text variant="caption" tone="accent">
                  {secondary.title}
                </Text>
              </Text>
            </Pressable>
          ) : null}
          <RichText text={post.body} variant={detail ? 'bodyLarge' : 'body'} numberOfLines={detail ? undefined : 6} />
        </View>
      ) : post.type === 'reaction' ? (
        <RichText text={post.body} variant={detail ? 'headline' : 'titleLarge'} numberOfLines={detail ? undefined : 5} />
      ) : (
        <RichText text={post.body} variant={detail ? 'bodyLarge' : 'body'} numberOfLines={detail ? undefined : 6} />
      )}
      {post.video ? (
        <FeedVideo
          post={post}
          width={imageW}
          detail={detail}
          onOpen={
            post.type === 'short'
              ? () => router.push({ pathname: '/shorts', params: { id: post.id } })
              : detail
                ? () => router.push({ pathname: '/media', params: { postId: post.id, index: '0' } })
                : open
          }
        />
      ) : post.images?.length ? (
        <ImageCarousel
          images={post.images}
          width={imageW}
          height={post.images.length > 1 ? Math.round(imageW * 1.05) : Math.round(imageW / aspect.postImage) * 0.7}
          onPressImage={(i) => router.push({ pathname: '/media', params: { postId: post.id, index: String(i) } })}
        />
      ) : null}
    </View>
  );

  return (
    <>
      <Tap onPress={detail ? undefined : open} disabled={detail} scaleTo={0.995} accessibilityRole={detail ? undefined : 'button'} style={[styles.card, style]}>
        {reason ? (
          <View style={styles.reason}>
            <Ionicons name="sparkles-outline" size={12} color={colors.textTertiary} />
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {reason}
            </Text>
          </View>
        ) : null}

        {/* Author */}
        <View style={styles.author}>
          <Pressable onPress={() => author && router.push(`/user/${author.handle}`)} accessibilityRole="link" accessibilityLabel={`${author?.displayName ?? 'Unknown'} profile`} hitSlop={6}>
            <Avatar uri={author?.avatarUrl} name={author?.displayName ?? '?'} size="md" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text variant="titleSmall" numberOfLines={1} onPress={() => author && router.push(`/user/${author.handle}`)}>
                {author?.displayName ?? 'Unknown'}
              </Text>
              {author?.verified ? <Ionicons name="checkmark-circle" size={14} color={colors.accentText} /> : null}
              <Text variant="caption" tone="tertiary">
                @{author?.handle} · {timeAgo(post.createdAt)}
                {post.editedAt ? ' · edited' : ''}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text variant="caption" tone="secondary">
                {TYPE_LABEL[post.type]}
              </Text>
              <SpoilerTag level={post.spoiler} compact />
            </View>
          </View>
          <Pressable onPress={() => setMenu(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="More options" style={styles.more}>
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* Context strip */}
        {!hideContext && drama ? (
          <Pressable
            onPress={() => router.push(post.context.episode ? `/episode/${drama.id}/${post.context.season ?? 1}/${post.context.episode}` : `/drama/${drama.id}`)}
            style={styles.context}
            accessibilityRole="link"
            accessibilityLabel={`${drama.title}${epLabel ? ` ${epLabel}` : ''}`}
          >
            <Poster drama={drama} width={28} rounded={4} />
            {/* World first, then the title: "Anime · Frieren" — the context the brief asks for. */}
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {dramaLabel(drama)}
            </Text>
            <Text variant="caption" tone="tertiary" accessibilityElementsHidden>
              ·
            </Text>
            <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
              {drama.title}
            </Text>
            {epLabel ? (
              <View style={styles.epChip}>
                <Text variant="caption" tone="accent" numeric>
                  {epLabel}
                </Text>
              </View>
            ) : null}
            {actors.length ? (
              <Pressable
                onPress={() => router.push(`/actor/${actors[0]!.id}`)}
                hitSlop={6}
                accessibilityRole="link"
                accessibilityLabel={actors.map((a) => a!.name).join(', ')}
                style={{ flexShrink: 1 }}
              >
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                  · {actors.map((a) => a!.name).join(', ')}
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        ) : null}

        {/* Body (veiled or not) */}
        <SpoilerBlock id={post.id} level={post.spoiler} drama={drama} season={post.context.season} episode={post.context.episode} veiled={veiled}>
          {Body}
          {post.poll ? <PollBlock postId={post.id} poll={post.poll} /> : null}
        </SpoilerBlock>

        {/* Hashtags not already inline in the body */}
        {post.hashtags.length && !veiled ? (
          <View style={styles.tagRow}>
            {post.hashtags
              .filter((t) => detail || !post.body.toLowerCase().includes(`#${t.toLowerCase()}`))
              .slice(0, 5)
              .map((t) => (
                <Pressable
                  key={t}
                  onPress={() => router.push({ pathname: '/search', params: { q: `#${t}`, scope: 'posts' } })}
                  hitSlop={4}
                  accessibilityRole="link"
                  accessibilityLabel={`#${t}`}
                >
                  <Text variant="caption" tone="accent">
                    #{t}
                  </Text>
                </Pressable>
              ))}
          </View>
        ) : null}

        {/* Actions */}
        <View style={styles.actions}>
          <ReactionButton targetId={post.id} counts={post.reactions} />
          <Pressable onPress={onOpenComments ?? open} hitSlop={6} style={styles.action} accessibilityRole="button" accessibilityLabel={`${post.commentCount} comments`}>
            <Ionicons name="chatbubble-outline" size={20} color={colors.textSecondary} />
            {post.commentCount ? (
              <Text variant="label" tone="secondary" numeric>
                {compact(post.commentCount)}
              </Text>
            ) : null}
          </Pressable>
          <Pressable onPress={save} hitSlop={6} style={styles.action} accessibilityRole="button" accessibilityLabel={saved ? 'Unsave' : 'Save'}>
            <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={20} color={saved ? colors.accentText : colors.textSecondary} />
          </Pressable>
          {(post.video || post.images?.length) ? (
            <Pressable onPress={download} hitSlop={6} style={styles.action} accessibilityRole="button" accessibilityLabel={toDevice ? 'Saved to device' : 'Download'} accessibilityState={{ busy: saving }}>
              {saving ? (
                <Text variant="label" tone="accent" numeric>
                  {savePct > 0 ? `${savePct}%` : '…'}
                </Text>
              ) : (
                <Ionicons name={toDevice ? 'download' : 'download-outline'} size={20} color={toDevice ? colors.accentText : colors.textSecondary} />
              )}
            </Pressable>
          ) : null}
          <Pressable onPress={share} hitSlop={6} style={styles.action} accessibilityRole="button" accessibilityLabel="Share">
            <Ionicons name="share-outline" size={20} color={colors.textSecondary} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <ReactionSummary counts={post.reactions} />
        </View>
      </Tap>

      <Sheet visible={menu} onClose={() => setMenu(false)} title={author ? `${TYPE_LABEL[post.type]} by ${author.displayName}` : TYPE_LABEL[post.type]}>
        <SheetRow
          icon={saved ? 'bookmark' : 'bookmark-outline'}
          label={saved ? 'Remove from Saved' : 'Save'}
          onPress={() => {
            setMenu(false);
            save();
          }}
        />
        <SheetRow
          icon="share-outline"
          label="Share"
          onPress={() => {
            setMenu(false);
            share();
          }}
        />
        {(post.video || post.images?.length) ? (
          <SheetRow
            icon="download-outline"
            label="Download"
            detail={post.video ? 'Video to your device' : 'Image to your photos'}
            onPress={() => {
              setMenu(false);
              download();
            }}
          />
        ) : null}
        <SheetRow
          icon="link-outline"
          label="Copy link"
          onPress={async () => {
            setMenu(false);
            await Clipboard.setStringAsync(`https://hallyu.app/p/${post.id}`).catch(() => {});
            toast.show('Link copied');
          }}
        />
        {drama ? (
          <SheetRow
            icon="film-outline"
            label={`Go to ${drama.title}`}
            onPress={() => {
              setMenu(false);
              router.push(`/drama/${drama.id}`);
            }}
          />
        ) : null}
        {isMine ? (
          <>
            {Date.now() - new Date(post.createdAt).getTime() < 15 * 60_000 ? (
              <SheetRow
                icon="create-outline"
                label="Edit"
                detail="Within 15 minutes of posting"
                onPress={() => {
                  setMenu(false);
                  router.push({ pathname: '/create/[type]', params: { type: post.type, editId: post.id } });
                }}
              />
            ) : null}
            <SheetRow
              icon="trash-outline"
              label="Delete"
              tone="danger"
              onPress={() => {
                setMenu(false);
                dispatch({ type: 'deletePost', id: post.id });
                toast.show({ message: 'Post deleted' });
              }}
            />
          </>
        ) : (
          <>
            <SheetRow
              icon="volume-mute-outline"
              label={`Mute @${author?.handle}`}
              detail="Hide their posts from your feeds"
              onPress={() =>
                require('mute people', () => {
                  setMenu(false);
                  dispatch({ type: 'muteUser', userId: post.authorId, on: true });
                  toast.show({ message: `Muted @${author?.handle}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'muteUser', userId: post.authorId, on: false }) });
                })
              }
            />
            {drama ? (
              <SheetRow
                icon="eye-off-outline"
                label={`Mute ${drama.title}`}
                detail="Hide posts about this drama"
                onPress={() =>
                  require('mute dramas', () => {
                    setMenu(false);
                    dispatch({ type: 'muteDrama', dramaId: drama.id, on: true });
                    toast.show({ message: `Muted ${drama.title}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'muteDrama', dramaId: drama.id, on: false }) });
                  })
                }
              />
            ) : null}
            <SheetRow
              icon="flag-outline"
              label="Report"
              detail="Unmarked spoiler, harassment, spam…"
              onPress={() => {
                setMenu(false);
                router.push({ pathname: '/report', params: { targetId: post.id, kind: 'post' } });
              }}
            />
            <SheetRow
              icon="ban-outline"
              label={`Block @${author?.handle}`}
              tone="danger"
              onPress={() =>
                require('block people', () => {
                  setMenu(false);
                  dispatch({ type: 'block', userId: post.authorId, on: true });
                  toast.show({ message: `Blocked @${author?.handle}. You won't see each other.`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'block', userId: post.authorId, on: false }) });
                })
              }
            />
          </>
        )}
      </Sheet>
      <ShareCardModal visible={shareOpen} onClose={() => setShareOpen(false)} post={post} drama={drama} author={author} />
    </>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: space.margin, paddingVertical: space.x4, gap: space.x3, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, backgroundColor: colors.canvas },
  tombstone: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: -4 },
  author: { flexDirection: 'row', alignItems: 'center', gap: space.x3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1 },
  more: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  context: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    backgroundColor: colors.surface1,
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  epChip: { backgroundColor: colors.accentSoft, paddingHorizontal: 6, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  kindRow: { flexDirection: 'row' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: space.x3 },
  ratingBox: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    backgroundColor: colors.warmSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
  },
  reviewShowcase: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  recPairCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.x2,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  recCol: {
    alignItems: 'center',
    gap: 5,
    flex: 1,
  },
  recArrow: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recSaveBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recSaveBtnOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2, marginTop: -4 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: -4 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 6 },
});

/** Memoised: with tracked store getters, a card re-renders only when its own data changes. */
export const PostCard = React.memo(PostCardBase);
