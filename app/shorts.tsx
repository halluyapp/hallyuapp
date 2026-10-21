import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { ResizeMode, Video } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, StatusBar, StyleSheet, TextInput, useWindowDimensions, View, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShareCardModal } from '../components/share/ShareCardModal';
import { VideoAccessSheet } from '../components/video/VideoAccessSheet';
import { fetchVideoAccessStatus, type VideoAccessStatus } from '../lib/api/features';
import { commentsFor } from '../lib/selectors';
import { ReactionButton } from '../components/feed/Reactions';
import { RichText } from '../components/feed/RichText';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { Poster } from '../components/ui/Poster';
import { Sheet, SheetRow } from '../components/ui/Sheet';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { useToast } from '../components/ui/Toast';
import { colors, radius, space } from '../constants/theme';
import { compact } from '../lib/format';
import { haptic, useApp, useReduceMotion, useRequireMember } from '../lib/hooks';
import { emptyReactions, Post } from '../lib/model';
import { uid } from '../lib/store';
import { shorts as selectShorts } from '../lib/selectors';
import { veilCopy } from '../lib/spoiler';

/**
 * Shorts — vertical, full-bleed, one at a time. Spoiler-veiled shorts stay covered until you choose.
 * Autoplay follows your setting; reduced motion means tap-to-play.
 */
export default function Shorts() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const params = useLocalSearchParams<{ id?: string; dramaId?: string }>();
  const { state } = useApp();
  const require = useRequireMember();
  const reduce = useReduceMotion(state.prefs.reduceMotion);
  const all = useMemo(() => selectShorts(state), [state]);
  const list = useMemo(() => {
    const scoped = params.dramaId ? all.filter((p) => p.context.dramaId === params.dramaId) : all;
    if (!params.id) return scoped;
    const i = scoped.findIndex((p) => p.id === params.id);
    return i > 0 ? [...scoped.slice(i), ...scoped.slice(0, i)] : scoped;
  }, [all, params.id, params.dramaId]);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(reduce || state.prefs.autoplay === 'never');
  const [accessSheet, setAccessSheet] = useState(false);
  const [accessStatus, setAccessStatus] = useState<VideoAccessStatus | null>(null);
  const itemH = height;

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first && typeof first.index === 'number') setActive(first.index);
  }).current;

  useEffect(() => {
    StatusBar.setBarStyle('light-content');
  }, []);

  const closeShorts = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));

  if (!list.length) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, paddingTop: insets.top }}>
        <IconButton icon="close" label="Close" onPress={closeShorts} style={{ margin: space.x2 }} />
        <EmptyState
          icon="videocam-outline"
          title="No shorts here yet"
          body={params.dramaId ? 'Nobody has cut a short for this drama. Yours could be the first.' : 'Shorts from people and dramas you follow will show up here.'}
          actionLabel="Make a short"
          onAction={() =>
            require('post a Short', async () => {
              const access = await fetchVideoAccessStatus().catch(() => null);
              if (access?.allowed) {
                router.replace({ pathname: '/create/[type]', params: { type: 'short', ...(params.dramaId ? { dramaId: params.dramaId } : {}) } });
              } else {
                setAccessStatus(access);
                setAccessSheet(true);
              }
            })
          }
        />
        <VideoAccessSheet
          visible={accessSheet}
          onClose={() => setAccessSheet(false)}
          initialStatus={accessStatus}
          onStatusChange={setAccessStatus}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        pagingEnabled
        snapToInterval={itemH}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: itemH, offset: itemH * i, index: i })}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 70 }}
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        removeClippedSubviews
        renderItem={({ item, index }) => <ShortItem post={item} height={itemH} width={width} active={index === active} muted={muted} paused={paused} onTogglePause={() => setPaused((p) => !p)} onToggleMute={() => setMuted((m) => !m)} position={`${index + 1}/${list.length}`} />}
      />
      <View style={[styles.top, { top: insets.top }]}>
        <IconButton icon="close" label="Close shorts" onPress={closeShorts} tone="onMedia" />
        <Text variant="label" style={{ color: colors.onMedia }}>
          Shorts
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IconButton
            icon="add-circle-outline"
            label="Post a short"
            tone="onMedia"
            onPress={() =>
              require('post a Short', async () => {
                const access = await fetchVideoAccessStatus().catch(() => null);
                if (access?.allowed) {
                  router.push('/create/short');
                } else {
                  setAccessStatus(access);
                  setAccessSheet(true);
                }
              })
            }
          />
          <IconButton icon={muted ? 'volume-mute' : 'volume-high'} label={muted ? 'Unmute' : 'Mute'} onPress={() => setMuted((m) => !m)} tone="onMedia" />
        </View>
      </View>
      <VideoAccessSheet
        visible={accessSheet}
        onClose={() => setAccessSheet(false)}
        initialStatus={accessStatus}
        onStatusChange={setAccessStatus}
      />
    </View>
  );
}

function ShortItem({ post, height, width, active, muted, paused, onTogglePause, onToggleMute, position }: { post: Post; height: number; width: number; active: boolean; muted: boolean; paused: boolean; onTogglePause: () => void; onToggleMute: () => void; position: string }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { getUser, getDrama, isPostVeiled, dispatch, isSaved, state, watch, me } = useApp();
  const require = useRequireMember();
  const author = getUser(post.authorId);
  const drama = getDrama(post.context.dramaId);
  const veiled = isPostVeiled(post);
  const [menu, setMenu] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const postComments = useMemo(() => commentsFor(state, post.id), [state, post.id]);
  const videoRef = useRef<Video>(null);
  const heart = useRef(new Animated.Value(0)).current;
  const lastTap = useRef(0);
  const playing = active && !paused && !veiled;
  const reduce = useReduceMotion(state.prefs.reduceMotion);

  // Chrome (rail + caption) fades after 2.5s of watching; any touch brings it back. Caption rises in on arrival.
  const chrome = useRef(new Animated.Value(1)).current;
  const caption = useRef(new Animated.Value(0)).current;
  const [chromeVisible, setChromeVisible] = useState(true);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    setChromeVisible(true);
    Animated.timing(chrome, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    idle.current = setTimeout(() => {
      if (reduce) return;
      Animated.timing(chrome, { toValue: 0, duration: 400, useNativeDriver: true }).start(({ finished }) => finished && setChromeVisible(false));
    }, 2500);
  }, [chrome, reduce]);

  useEffect(() => {
    if (!active) {
      videoRef.current?.setPositionAsync(0).catch(() => {});
      caption.setValue(0);
      return;
    }
    Animated.timing(caption, { toValue: 1, duration: reduce ? 0 : 400, delay: reduce ? 0 : 160, useNativeDriver: true }).start();
    if (!veiled && !paused) wake();
    else {
      if (idle.current) clearTimeout(idle.current);
      setChromeVisible(true);
      chrome.setValue(1);
    }
    return () => {
      if (idle.current) clearTimeout(idle.current);
    };
  }, [active, veiled, paused, wake, caption, chrome, reduce]);

  const doubleTap = useCallback(() => {
    wake();
    const t = Date.now();
    if (t - lastTap.current < 280) {
      require('react to shorts', () => {
        if (!state.reactions[post.id]) dispatch({ type: 'react', targetId: post.id, kind: 'loved' });
        haptic.light();
        heart.setValue(0);
        Animated.sequence([Animated.spring(heart, { toValue: 1, useNativeDriver: true, damping: 8 }), Animated.timing(heart, { toValue: 0, duration: 400, delay: 300, useNativeDriver: true })]).start();
      });
    } else onTogglePause();
    lastTap.current = t;
  }, [require, state.reactions, post.id, dispatch, heart, onTogglePause, wake]);

  const wl = drama ? watch(drama.id) : undefined;
  const bottomPad = insets.bottom + space.x4;

  return (
    <View style={{ height, width, backgroundColor: drama?.tone ?? '#000' }}>
      {!veiled && post.video && !failed ? (
        <Video
          ref={videoRef}
          source={{ uri: post.video.url }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          shouldPlay={playing}
          isLooping
          isMuted={muted}
          onError={() => setFailed(true)}
          onPlaybackStatusUpdate={(s) => {
            if (s.isLoaded && s.durationMillis) {
              setDurationMs(s.durationMillis);
              setProgress(s.positionMillis / s.durationMillis);
            }
          }}
          progressUpdateIntervalMillis={180}
          accessibilityLabel={`Video: ${post.body}`}
        />
      ) : drama ? (
        <Poster drama={drama} width={width} rounded={0} style={{ height, opacity: veiled ? 0.2 : 0.7 }} />
      ) : null}
      <Pressable style={StyleSheet.absoluteFill} onPress={doubleTap} accessibilityRole="button" accessibilityLabel={paused ? 'Play' : 'Pause'} accessibilityHint="Double tap to react" />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0.88)']}
        locations={[0, 0.52, 1]}
        style={styles.scrimBottom}
      />

      {paused && !veiled ? (
        <View pointerEvents="none" style={styles.center}>
          <View style={styles.playBadge}>
            <Ionicons name="play" size={30} color={colors.onMedia} />
          </View>
        </View>
      ) : null}
      {failed && !veiled ? (
        <View pointerEvents="none" style={styles.center}>
          <Text variant="caption" style={{ color: colors.onMedia }}>
            Video unavailable right now
          </Text>
        </View>
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.center, { transform: [{ scale: heart }], opacity: heart }]}>
        <Ionicons name="heart" size={96} color={colors.accent} />
      </Animated.View>

      {veiled ? (
        <View style={styles.veil}>
          <Ionicons name="eye-off-outline" size={32} color={colors.textPrimary} />
          <Text variant="titleSmall" align="center" style={{ marginTop: space.x3 }}>
            {veilCopy(post.spoiler, drama?.title, post.context.season, post.context.episode, (drama?.seasons.length ?? 1) > 1)}
          </Text>
          <Text variant="bodySmall" tone="secondary" align="center" style={{ marginTop: 4 }}>
            {wl?.status === 'watching' ? `You’re on episode ${wl.currentEpisode}.` : 'Covered because of your spoiler protection.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x4 }}>
            <Button label="Reveal" size="sm" variant="secondary" onPress={() => dispatch({ type: 'reveal', id: post.id })} />
            {drama && post.context.episode ? <Button label={`Watched Ep ${post.context.episode}`} size="sm" onPress={() => require('mark episodes watched', () => dispatch({ type: 'progress', dramaId: drama.id, season: post.context.season ?? 1, episode: post.context.episode!, total: drama.seasons.find((s) => s.number === (post.context.season ?? 1))?.episodeCount ?? drama.episodeCount }))} /> : null}
          </View>
        </View>
      ) : null}

      <Animated.View style={[styles.rail, { bottom: bottomPad + 8, opacity: chrome }]} pointerEvents={chromeVisible ? 'auto' : 'none'}>
        <Pressable onPress={() => router.push(`/user/${author?.handle}`)} accessibilityRole="button" accessibilityLabel={`Open ${author?.displayName}`}>
          <Avatar uri={author?.avatarUrl} name={author?.displayName ?? '?'} size={44} ring />
        </Pressable>
        <View style={styles.railItem}>
          <ReactionButton targetId={post.id} counts={post.reactions} />
        </View>
        <Pressable
          onPress={() => {
            haptic.light();
            setCommentsOpen(true);
          }}
          style={styles.railItem}
          accessibilityRole="button"
          accessibilityLabel={`${post.commentCount} comments`}
        >
          <Ionicons name="chatbubble-outline" size={26} color={colors.onMedia} />
          <Text variant="caption" style={{ color: colors.onMedia }} numeric>
            {compact(Math.max(post.commentCount, postComments.length))}
          </Text>
        </Pressable>
        <Pressable onPress={() => require('save posts', () => { dispatch({ type: 'save', postId: post.id }); toast.show({ message: isSaved(post.id) ? 'Removed from saved' : 'Saved', aboveTabBar: false }); })} style={styles.railItem} accessibilityRole="button" accessibilityLabel={isSaved(post.id) ? 'Unsave' : 'Save'}>
          <Ionicons name={isSaved(post.id) ? 'bookmark' : 'bookmark-outline'} size={26} color={colors.onMedia} />
        </Pressable>
        <Pressable
          onPress={() => {
            haptic.light();
            setShareOpen(true);
          }}
          style={styles.railItem}
          accessibilityRole="button"
          accessibilityLabel="Share card or send to friend"
        >
          <Ionicons name="paper-plane-outline" size={25} color={colors.onMedia} />
        </Pressable>
        <Pressable onPress={() => setMenu(true)} style={styles.railItem} accessibilityRole="button" accessibilityLabel="More">
          <Ionicons name="ellipsis-horizontal" size={26} color={colors.onMedia} />
        </Pressable>
      </Animated.View>

      <Animated.View style={[styles.meta, { bottom: bottomPad, width: width - 84, opacity: Animated.multiply(chrome, caption), transform: [{ translateY: caption.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]} pointerEvents={chromeVisible ? 'auto' : 'none'}>
        <Pressable onPress={() => router.push(`/user/${author?.handle}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityRole="link">
          <Text variant="label" style={{ color: colors.onMedia }}>
            {author?.displayName}
          </Text>
          <Text variant="caption" style={{ color: colors.textSecondary }}>
            @{author?.handle}
          </Text>
        </Pressable>
        <Pressable onPress={() => setExpanded((e) => !e)} accessibilityRole="button">
          <RichText text={post.body} variant="bodySmall" tone="onMedia" numberOfLines={expanded ? undefined : 2} />
        </Pressable>
        {drama ? (
          <Pressable onPress={() => router.push(`/drama/${drama.id}`)} style={styles.dramaChip} accessibilityRole="link" accessibilityLabel={`Open ${drama.title}`}>
            <Poster drama={drama} width={16} rounded={2} />
            <Text variant="caption" style={{ color: colors.onMedia }} numberOfLines={1}>
              {drama.title}
              {post.context.episode ? ` · Ep ${post.context.episode}` : ''}
            </Text>
            <Ionicons name="chevron-forward" size={12} color={colors.onMedia} />
          </Pressable>
        ) : null}
        <Text variant="caption" style={{ color: colors.textTertiary }}>
          {position}
          {post.video ? ` · ${post.video.duration}s` : ''}
        </Text>
      </Animated.View>

      <Pressable
        onPress={(e) => {
          if (!durationMs) return;
          const ratio = Math.max(0, Math.min(1, e.nativeEvent.locationX / Math.max(1, width)));
          setProgress(ratio);
          videoRef.current?.setPositionAsync(Math.round(ratio * durationMs)).catch(() => {});
        }}
        hitSlop={12}
        style={[styles.progress, { bottom: insets.bottom }]}
        accessibilityRole="adjustable"
        accessibilityLabel="Scrub video timeline"
      >
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </Pressable>

      {/* Slide-Up In-Player Live Comments Drawer */}
      <Sheet visible={commentsOpen} onClose={() => setCommentsOpen(false)} title={`Comments · ${Math.max(post.commentCount, postComments.length)}`}>
        <View style={{ paddingHorizontal: space.margin, paddingBottom: space.x3, gap: space.x3, maxHeight: 380 }}>
          {postComments.length === 0 ? (
            <Text variant="bodySmall" tone="secondary" style={{ paddingVertical: space.x4 }}>
              No comments yet — be the first to react to this short.
            </Text>
          ) : (
            <FlatList
              data={postComments}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 260 }}
              ItemSeparatorComponent={() => <View style={{ height: space.x3 }} />}
              renderItem={({ item: c }) => {
                const cu = getUser(c.authorId);
                return (
                  <View style={{ flexDirection: 'row', gap: space.x2 + 2 }}>
                    <Avatar uri={cu?.avatarUrl} name={cu?.displayName ?? '?'} size="xs" />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="label">{cu?.displayName ?? 'Member'}</Text>
                      <Text variant="bodySmall" tone="secondary">
                        {c.body}
                      </Text>
                    </View>
                  </View>
                );
              }}
            />
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingTop: space.x2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle }}>
            <TextInput
              value={replyText}
              onChangeText={setReplyText}
              placeholder="Add a comment…"
              placeholderTextColor={colors.textTertiary}
              style={{
                flex: 1,
                height: 38,
                paddingHorizontal: 12,
                borderRadius: radius.full,
                backgroundColor: colors.surface2,
                color: colors.textPrimary,
                fontSize: 14,
              }}
            />
            <Button
              label="Post"
              size="sm"
              disabled={!replyText.trim()}
              onPress={() => {
                const clean = replyText.trim();
                if (!clean) return;
                require('comment on shorts', () => {
                  haptic.success();
                  dispatch({
                    type: 'addComment',
                    comment: {
                      id: uid(''),
                      postId: post.id,
                      authorId: me.id,
                      body: clean,
                      createdAt: new Date().toISOString(),
                      spoiler: 'none',
                      reactions: emptyReactions(),
                    },
                  });
                  setReplyText('');
                });
              }}
            />
          </View>
        </View>
      </Sheet>

      <ShareCardModal
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        post={post}
        drama={drama}
      />

      <Sheet visible={menu} onClose={() => setMenu(false)} title="This short">
        <SheetRow icon="open-outline" label="Open as post" onPress={() => { setMenu(false); router.push(`/post/${post.id}`); }} />
        <SheetRow icon={muted ? 'volume-high-outline' : 'volume-mute-outline'} label={muted ? 'Unmute' : 'Mute'} onPress={() => { setMenu(false); onToggleMute(); }} />
        {author ? <SheetRow icon="person-remove-outline" label={`Mute @${author.handle}`} onPress={() => { setMenu(false); dispatch({ type: 'muteUser', userId: author.id, on: true }); toast.show({ message: `Muted @${author.handle}`, aboveTabBar: false }); }} /> : null}
        <SheetRow icon="flag-outline" label="Report" tone="danger" onPress={() => { setMenu(false); router.push({ pathname: '/report', params: { targetId: post.id, kind: 'post' } }); }} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 0, right: 0, height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.x2 },
  scrimBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 280 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playBadge: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingLeft: 4 },
  veil: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x8, backgroundColor: 'rgba(10,10,10,0.7)' },
  rail: { position: 'absolute', right: space.x2, alignItems: 'center', gap: space.x4 },
  railItem: { alignItems: 'center', gap: 2, minWidth: 48 },
  meta: { position: 'absolute', left: space.margin, gap: space.x2 },
  dramaChip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 8, height: 28, borderRadius: radius.full, backgroundColor: 'rgba(255,255,255,0.14)' },
  progress: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.2)' },
  progressFill: { height: 2, backgroundColor: colors.accent },
});
