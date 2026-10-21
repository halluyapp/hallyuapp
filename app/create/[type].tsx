import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { makePoster } from '../../lib/media';
import { attachAsset, discardAssets, MediaPipelineError, uploadAsset, uploadPoster, verifyPostMedia } from '../../lib/api/media';
import type { UploadProgress } from '../../lib/api/media';
import { fetchPosts } from '../../lib/api/feed';
import { insertPost } from '../../lib/api/social';
import { adoptLocal, worldOf } from '../../lib/sync';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CREATE_TYPES } from '../../components/create/CreateSheet';
import { ActorPickerSheet, DramaPickerSheet, EpisodePickerSheet, SpoilerSheet } from '../../components/create/pickers';
import { ActorPortrait } from '../../components/drama/ActorCard';
import { KIND_LABEL } from '../../components/feed/PostCard';
import { ReactionGlyph } from '../../components/feed/Reactions';
import { SpoilerTag } from '../../components/feed/SpoilerBlock';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Dialog } from '../../components/ui/Dialog';
import { Poster } from '../../components/ui/Poster';
import { Screen } from '../../components/ui/Screen';
import { ProgressBar } from '../../components/ui/Section';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { VideoAccessSheet } from '../../components/video/VideoAccessSheet';
import { fetchVideoAccessStatus, type VideoAccessStatus } from '../../lib/api/features';
import { colors, fonts, radius, space } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { extractHashtags, extractMentions, fileSize, uid } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';
import { DiscussionKind, Draft, LIMITS, Post, PostType, REACTIONS, ReactionKind, SpoilerLevel } from '../../lib/model';
import { allActors, newPost } from '../../lib/store';
import { videoUploadsAvailable } from '../../lib/video';
import { SPOILER_LABEL, suggestSpoilerLevel } from '../../lib/spoiler';
import { track } from '../../lib/analytics';

const KINDS: DiscussionKind[] = ['general', 'theory', 'ending', 'character', 'scene', 'question'];

type PublishStage = {
  step: 'upload' | 'create' | 'attach' | 'verify';
  detail: string;
  /** Present only while the transport is reporting bytes; absent means the step has no byte report. */
  sent?: number;
  total?: number;
};

/**
 * What the composer shows while a post is being published.
 *
 * A publish is not one wait: the bytes go up first, then the post row is created, then each file is
 * attached and re-read to prove the server has it. Each of those is a line the member can see, and
 * the bar under it is a real fraction of a real file — never a timer pretending to be progress. Once
 * every file is uploaded the bar gives way to the count of finished files, because the attach and
 * verify steps have no bytes to report and a bar that keeps filling through them would be a lie.
 */
function PublishProgress({ stage }: { stage: PublishStage }) {
  const pct = stage.sent != null && stage.total ? Math.min(100, Math.round((stage.sent / stage.total) * 100)) : null;
  const headline = stage.step === 'upload' ? 'Uploading' : stage.step === 'create' ? 'Publishing' : stage.step === 'attach' ? 'Attaching' : 'Confirming';
  const line =
    pct != null
      ? `${fileSize(stage.sent!)} of ${fileSize(stage.total!)} · ${pct}%`
      : stage.step === 'upload'
        ? 'Sending to the server…'
        : stage.step === 'create'
          ? 'Saving your post…'
          : stage.step === 'attach'
            ? 'Linking the files to your post…'
            : 'Making sure the server has everything…';
  return (
    <View
      style={styles.publish}
      accessibilityRole="progressbar"
      accessibilityLabel={`${headline} ${stage.detail}, ${line}`}
      accessibilityValue={pct != null ? { min: 0, max: 100, now: pct } : undefined}
      accessibilityLiveRegion="polite"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
        {pct != null ? (
          <Ionicons name="cloud-upload-outline" size={16} color={colors.accentText} />
        ) : (
          <ActivityIndicator size="small" color={colors.accentText} />
        )}
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {headline} · {stage.detail}
        </Text>
        <View style={{ flex: 1 }} />
        <Text variant="caption" tone="secondary">
          {line}
        </Text>
      </View>
      {/* Bytes we can count get a bar; steps that report nothing get the spinner above and no bar,
          because a bar that moves without bytes behind it is a decoration pretending to be data. */}
      {pct != null ? <ProgressBar value={pct} max={100} height={4} /> : null}
      <Text variant="caption" tone="tertiary">
        Keep this screen open. If it fails, your draft is kept and you can retry.
      </Text>
    </View>
  );
}

/**
 * The adaptive composer. One screen, six shapes. Context (drama / episode / actor) arrives via params
 * or gets attached here; spoiler level is explicit; drafts save on exit.
 */
export default function Composer() {
  const router = useRouter();
  const navigation = useNavigation();
  const toast = useToast();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ type: PostType; dramaId?: string; season?: string; episode?: string; actorId?: string; communityId?: string; draftId?: string; tag?: string; editId?: string; poll?: string }>();
  const { state, dispatch, me, getDrama, getPost, watch } = useApp();
  const type: PostType = (CREATE_TYPES.some((t) => t.type === params.type) ? params.type : 'post') as PostType;
  const meta = CREATE_TYPES.find((t) => t.type === type)!;
  const draft = useMemo(() => state.drafts.find((d) => d.id === params.draftId), [state.drafts, params.draftId]);
  const editing = useMemo(() => getPost(params.editId), [getPost, params.editId]);

  const [body, setBody] = useState(draft?.body ?? editing?.body ?? (params.tag ? `#${params.tag} ` : ''));
  const [title, setTitle] = useState(draft?.title ?? editing?.title ?? '');
  const [kind, setKind] = useState<DiscussionKind>(draft?.kind ?? editing?.kind ?? 'general');
  const [rating, setRating] = useState<number | undefined>(draft?.rating ?? editing?.rating);
  const [verdict, setVerdict] = useState(draft?.verdict ?? editing?.verdict ?? '');
  const [pollOpen, setPollOpen] = useState<boolean>(Boolean(params.poll === '1' || editing?.poll));
  const [pollQuestion, setPollQuestion] = useState<string>(editing?.poll?.question ?? '');
  const [pollOptions, setPollOptions] = useState<string[]>(editing?.poll?.options ?? ['', '']);
  const [dramaId, setDramaId] = useState<string | undefined>(draft?.context.dramaId ?? editing?.context.dramaId ?? params.dramaId);
  const [secondaryId, setSecondaryId] = useState<string | undefined>(draft?.context.secondaryDramaId ?? editing?.context.secondaryDramaId);
  const [ep, setEp] = useState<{ season: number; episode?: number } | undefined>(
    draft?.context.season
      ? { season: draft.context.season, episode: draft.context.episode }
      : editing?.context.season
        ? { season: editing.context.season, episode: editing.context.episode }
        : params.season
          ? { season: Number(params.season), episode: params.episode ? Number(params.episode) : undefined }
          : undefined,
  );
  const [actorIds, setActorIds] = useState<string[]>(draft?.context.actorIds ?? editing?.context.actorIds ?? (params.actorId ? [params.actorId] : []));
  const [spoiler, setSpoiler] = useState<SpoilerLevel>(draft?.spoiler ?? editing?.spoiler ?? (params.episode ? 'episode' : 'none'));
  const [images, setImages] = useState<string[]>(draft?.images ?? editing?.images?.filter((i): i is string => typeof i === 'string') ?? []);
  const [video, setVideo] = useState<{ uri: string; duration: number; poster?: string; width?: number; height?: number } | null>(
    editing?.video ? { uri: editing.video.url, duration: editing.video.duration, poster: typeof editing.video.poster === 'string' ? editing.video.poster : undefined } : null,
  );
  const [reactionKind, setReactionKind] = useState<ReactionKind>('loved');
  const [sheet, setSheet] = useState<null | 'drama' | 'secondary' | 'episode' | 'actors' | 'spoiler'>(null);
  // Progressive disclosure: a plain post starts as a clean page; drama/episode/actors/spoiler
  // controls appear once you ask for context — or immediately when the type needs a drama or
  // context arrived with the deep link / draft / edit.
  const [contextOpen, setContextOpen] = useState(false);
  const [leaveDialog, setLeaveDialog] = useState(false);
  const [guidelines, setGuidelines] = useState(!state.prefs.guidelinesAccepted);
  const [posting, setPosting] = useState(false);
  const [videoAccessOpen, setVideoAccessOpen] = useState(false);
  const [videoAccess, setVideoAccess] = useState<VideoAccessStatus | null>(null);

  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let alive = true;
    void fetchVideoAccessStatus()
      .then((s) => {
        if (!alive) return;
        setVideoAccess(s);
        if (type === 'short' && !s.allowed && !editing) {
          setVideoAccessOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth.status, type, editing]);
  /**
   * What the publish is doing right now. A spinner on the Post button was the whole story before:
   * a 45MB clip took minutes and the screen looked frozen. Every entry here is a step that really
   * happens — bytes that really left the device, a post the server really created — and `sent` is
   * only present when the transport reported it, so the bar never invents precision.
   */
  const [stage, setStage] = useState<{ step: 'upload' | 'create' | 'attach' | 'verify'; detail: string; sent?: number; total?: number } | null>(null);
  const bodyRef = useRef<TextInput>(null);
  const draftId = useRef(draft?.id ?? uid('d'));

  const drama = getDrama(dramaId);
  const secondary = getDrama(secondaryId);
  const wl = dramaId ? watch(dramaId) : undefined;
  const bodyLimit =
    type === 'post'
      ? LIMITS.post
      : type === 'reaction'
        ? LIMITS.reaction
        : type === 'discussion'
          ? LIMITS.discussionBody
          : type === 'review'
            ? LIMITS.reviewBody
            : type === 'recommendation'
              ? LIMITS.recommendation
              : LIMITS.shortCaption;
  const needsDrama = type !== 'post' && type !== 'short';
  const dirty = !!(body.trim() || title.trim() || images.length || video || verdict.trim() || rating);

  const mentionQuery = (() => {
    const m = /(?:^|\s)@(\w*)$/.exec(body);
    return m ? m[1]!.toLowerCase() : null;
  })();
  const mentionMatches =
    mentionQuery !== null ? Object.values(state.users).filter((u) => u.id !== me.id && (u.handle.toLowerCase().startsWith(mentionQuery) || u.displayName.toLowerCase().includes(mentionQuery))).slice(0, 4) : [];

  const problems: string[] = [];
  if (needsDrama && !drama) problems.push(`${meta.label}s need a drama.`);
  const validPollOptions = pollOptions.map((o) => o.trim()).filter(Boolean);
  if (pollOpen && validPollOptions.length < 2) problems.push('Add at least 2 poll options.');
  if (type === 'discussion' && title.trim().length < 3) problems.push('Give the discussion a title.');
  if (type === 'review' && !rating) problems.push('Pick a rating.');
  if (type === 'review' && !verdict.trim()) problems.push('Write a one-line verdict.');
  if (type === 'recommendation' && !secondary) problems.push('Add the drama you’re comparing it to.');
  if (type === 'short' && !video) problems.push('Add a video.');
  if (type !== 'review' && type !== 'short' && !body.trim() && !(pollOpen && pollQuestion.trim())) problems.push('Write something.');
  if (body.length > bodyLimit) problems.push(`Body is ${body.length - bodyLimit} over the limit.`);
  if (spoiler !== 'none' && !drama) problems.push('Spoiler levels need a drama attached.');
  const canPost = problems.length === 0 && !posting;
  // Soft spoiler net: suggest a level when the text reads like one and none is set. Dismissable per draft.
  const [ignoreHint, setIgnoreHint] = useState(false);
  const hint = useMemo(
    () =>
      drama && spoiler === 'none' && !ignoreHint
        ? suggestSpoilerLevel(`${title} ${verdict} ${body}`, { episode: ep?.episode, totalEpisodes: drama.seasons.find((s) => s.number === (ep?.season ?? 1))?.episodeCount ?? drama.episodeCount })
        : null,
    [drama, spoiler, ignoreHint, title, verdict, body, ep],
  );

  const saveDraft = useCallback(() => {
    const d: Draft = {
      id: draftId.current,
      type,
      updatedAt: new Date().toISOString(),
      title: title || undefined,
      body,
      rating,
      verdict: verdict || undefined,
      kind: type === 'discussion' ? kind : undefined,
      spoiler,
      context: { dramaId, season: ep?.season, episode: ep?.episode, actorIds, secondaryDramaId: secondaryId },
      images,
    };
    dispatch({ type: 'draft', draft: d });
  }, [type, title, body, rating, verdict, kind, spoiler, dramaId, ep, actorIds, secondaryId, images, dispatch]);

  // Intercept back/close while dirty.
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (!dirty || posting || editing) return;
      e.preventDefault();
      setLeaveDialog(true);
    });
    return sub;
  }, [navigation, dirty, posting, editing]);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  /**
   * Where a successful publish leaves the member.
   *
   * It used to be `goBack()`, which dropped them on Home — where a member's own post is ranked down
   * by design (×0.6) and, being seconds old, has no engagement to lift it, so it lands near the
   * bottom of the feed they are looking at. From the member's side the post they just wrote had
   * vanished. The composer now opens the post itself, and `posting` stays set so the unsaved-changes
   * guard on the way out stays disarmed, exactly as `leave()` does it.
   */
  const landOnPost = (postId: string, message: string) => {
    toast.show({ message, icon: 'checkmark-circle', tone: 'success' });
    setPosting(true);
    setTimeout(() => router.replace(`/post/${postId}`), 30);
  };
  const leave = (save: boolean) => {
    if (save) {
      saveDraft();
      toast.show({ message: 'Draft saved', actionLabel: 'Drafts', onAction: () => router.push('/drafts') });
    } else if (draft) dispatch({ type: 'deleteDraft', id: draft.id });
    setLeaveDialog(false);
    setPosting(true); // disarm the guard
    setTimeout(() => goBack(), 30);
  };

  const pickImages = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast.show({ message: 'Allow photo access in Settings to attach images.', tone: 'danger' });
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: LIMITS.images - images.length,
      quality: 0.85,
    });
    if (!res.canceled) {
      if (video) setVideo(null);
      setImages((prev) => [...prev, ...res.assets.map((a: { uri: string }) => a.uri)].slice(0, LIMITS.images));
    }
  };
  const pickVideo = async () => {
    if (auth.status !== 'signedIn') {
      return router.push({ pathname: '/(auth)/gate', params: { reason: 'publish videos & Shorts' } });
    }
    const access = videoAccess ?? (await fetchVideoAccessStatus().catch(() => null));
    if (access) setVideoAccess(access);
    if (!access?.allowed) {
      setVideoAccessOpen(true);
      return;
    }
    if (!(await videoUploadsAvailable()))
      return toast.show({ message: 'Video uploads aren’t available right now — the backend has no media bucket.', tone: 'danger' });
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast.show({ message: 'Allow photo access in Settings to attach a video.', tone: 'danger' });
    const max = type === 'short' ? LIMITS.shortVideo : LIMITS.postVideo;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos, allowsEditing: true, videoMaxDuration: max });
    if (res.canceled) return;
    const a = res.assets[0]!;
    const secs = Math.round((a.duration ?? 0) / 1000);
    if (secs && (secs < 3 || secs > max))
      return toast.show({ message: type === 'short' ? 'Shorts are 3 to 60 seconds. Trim it and try again.' : 'Clips in posts run 3 seconds to 2:20. Trim it and try again.', tone: 'danger' });
    if (images.length) {
      setImages([]);
      toast.show({ message: 'A post carries images or one video — images removed.' });
    }
    // Poster first frame with the Hallyu mark burned in, generated locally so publish never waits on it.
    const poster = await makePoster(a.uri);
    setVideo({ uri: a.uri, duration: secs || 15, poster, width: a.width, height: a.height });
  };

  const publish = () => {
    if (!canPost) return;
    if (auth.status !== 'signedIn') return router.push({ pathname: '/(auth)/gate', params: { reason: 'post' } });
    setPosting(true);
    const hashtags = extractHashtags(`${title} ${body} ${verdict}`);
    const mentions = extractMentions(body)
      .map((h) => Object.values(state.users).find((u) => u.handle.toLowerCase() === h.toLowerCase())?.id)
      .filter(Boolean) as string[];
    const context = {
      dramaId,
      season: ep?.season,
      episode: ep?.episode,
      actorIds: actorIds.length ? actorIds : undefined,
      secondaryDramaId: secondaryId,
      communityId: params.communityId,
    };
    const builtPoll =
      pollOpen && validPollOptions.length >= 2
        ? {
            question: pollQuestion.trim() || body.trim().slice(0, 140) || 'Vote below',
            options: validPollOptions.slice(0, 4),
            counts: validPollOptions.slice(0, 4).map(() => 0),
            totalVotes: 0,
            myVote: null,
          }
        : undefined;
    const common = {
      body: (body.trim() || pollQuestion.trim()).trim(),
      title: type === 'discussion' ? title.trim() : undefined,
      kind: type === 'discussion' ? kind : undefined,
      rating: type === 'review' ? rating : undefined,
      verdict: type === 'review' ? verdict.trim() : undefined,
      poll: builtPoll,
      spoiler,
      context,
      hashtags,
      mentions,
      images: images.length ? images : undefined,
      video: video ? { url: video.uri, duration: video.duration, poster: video.poster, width: video.width, height: video.height } : undefined,
    };
    if (editing) {
      dispatch({ type: 'editPost', id: editing.id, patch: { ...common, editedAt: new Date().toISOString() } });
      haptic.success();
      toast.show({ message: 'Post updated', icon: 'checkmark-circle', tone: 'success' });
      goBack();
      return;
    }
    const post = newPost(me.id, { type, ...common });
    if (type === 'reaction') post.reactions = { ...post.reactions, [reactionKind]: 1 };
    track('post.publish', { type, spoiler, hasDrama: !!dramaId, images: images.length, video: !!video });

    // Text-only posts keep the optimistic path (the mirror rolls the cache back if the server
    // refuses). A post carrying media cannot: the member has to be able to see the upload reach
    // the server, so it waits for the whole pipeline before anything claims success.
    if (images.length || video) {
      void publishWithMedia(post);
      return;
    }

    dispatch({ type: 'addPost', post });
    if (draft) dispatch({ type: 'deleteDraft', id: draft.id });
    haptic.success();
    landOnPost(post.id, type === 'review' ? 'Review published' : 'Posted');
  };

  /**
   * The media pipeline, in the order the backend requires it.
   *
   *   reserve path → send bytes → create the server post → attach each upload → read post_media back
   *
   * The last step is what makes "posted" honest: `complete_media_upload` returning a media id is
   * not proof on its own, so the composer re-reads `post_media` and refuses to claim success
   * unless the server really holds a row for every file it sent. Any failure throws, and this
   * function's catch turns that into "not posted, here's why, retry" with the draft intact — the
   * member never keeps a "Posted" toast for media the backend does not have.
   */
  const publishWithMedia = async (post: Post) => {
    const uploaded: string[] = [];
    try {
      const assets: { uploadId: string; posterPath?: string; width?: number | null; height?: number | null; durationMs?: number | null }[] = [];

      const onProgress = (detail: string) => (p: UploadProgress) => setStage({ step: 'upload', detail, sent: p.sent, total: p.total });

      for (const [i, uri] of images.entries()) {
        const detail = images.length > 1 ? `Image ${i + 1} of ${images.length}` : 'Your image';
        setStage({ step: 'upload', detail });
        const asset = await uploadAsset({ userId: me.id, uri, kind: 'image', unique: `${post.id}-${i}`, onProgress: onProgress(detail) });
        uploaded.push(asset.storagePath);
        assets.push({ uploadId: asset.uploadId });
      }

      if (video) {
        // The poster is its own object; `complete_media_upload` records its path on the video row.
        setStage({ step: 'upload', detail: 'Your video’s cover frame' });
        const posterPath = video.poster ? await uploadPoster({ userId: me.id, posterUri: video.poster, unique: post.id }) : undefined;
        if (posterPath) uploaded.push(posterPath);
        setStage({ step: 'upload', detail: 'Your video' });
        const asset = await uploadAsset({ userId: me.id, uri: video.uri, kind: 'video', unique: post.id, onProgress: onProgress('Your video') });
        asset.posterPath = posterPath;
        uploaded.push(asset.storagePath);
        assets.push({
          uploadId: asset.uploadId,
          posterPath,
          width: video.width ?? null,
          height: video.height ?? null,
          durationMs: Math.round(video.duration * 1000),
        });
      }

      // The post row must exist before media can be attached to it. The client id IS the server
      // id (social.insertPost inserts it explicitly), so the local post and the server post are
      // the same row — which is what lets the media be attached before anything is cached.
      setStage({ step: 'create', detail: 'Creating your post' });
      await insertPost(post, me.id, worldOf(state, post.context.dramaId));

      setStage({ step: 'attach', detail: assets.length > 1 ? `Attaching ${assets.length} files` : 'Attaching your file' });
      let position = 0;
      for (const asset of assets) {
        await attachAsset({
          uploadId: asset.uploadId,
          postId: post.id,
          position: position++,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
          posterPath: asset.posterPath ?? null,
        });
      }

      setStage({ step: 'verify', detail: 'Confirming with the server' });
      await verifyPostMedia(post.id, uploaded);

      // Adopt what the server actually stored (including signed media URLs) rather than the local
      // device URIs, so the cache and the backend agree on what this post contains.
      const [serverPost] = await fetchPosts([post.id]);
      if (!serverPost) throw new MediaPipelineError('verify', 'The post could not be read back after publishing, so it is not confirmed saved.');
      adoptLocal({ type: 'addPost', post: serverPost });

      track('post.publish.media', { images: images.length, video: !!video });
      if (draft) dispatch({ type: 'deleteDraft', id: draft.id });
      haptic.success();
      setStage(null);
      landOnPost(post.id, video ? (type === 'short' ? 'Short posted' : 'Posted with your video') : 'Posted');
    } catch (e) {
      // The bytes are not referenced by a post the member can see; take them out of the bucket so
      // an abandoned upload does not sit there until retention collects it.
      await discardAssets(uploaded);
      // Keep everything the member wrote, and let them try again from the same screen.
      saveDraft();
      setPosting(false);
      setStage(null);
      const why = e instanceof MediaPipelineError ? e.message : (e as Error)?.message || 'unknown error';
      track('post.publish.failed', { step: e instanceof MediaPipelineError ? e.step : 'unknown' });
      toast.show({
        message: `Not posted — ${why}. Your draft was kept; you can retry.`,
        tone: 'danger',
        icon: 'alert-circle',
        actionLabel: 'Drafts',
        onAction: () => router.push('/drafts'),
      });
    }
  };

  const contextVisible = contextOpen || needsDrama || !!drama || actorIds.length > 0 || spoiler !== 'none' || !!hint;
  const attachRow = !contextVisible ? (
    <View style={styles.attachRow}>
      <Pressable
        onPress={() => {
          haptic.select();
          setContextOpen(true);
        }}
        style={styles.attach}
        accessibilityRole="button"
        accessibilityLabel="Add context: drama, episode, actors or spoiler level"
        accessibilityHint="Reveals the context controls"
      >
        <Ionicons name="add-circle-outline" size={16} color={colors.textSecondary} />
        <Text variant="label">Add context</Text>
      </Pressable>
      <Text variant="caption" tone="tertiary" style={{ alignSelf: 'center' }}>
        Drama · episode · actors · spoiler level{type === 'post' ? ' · or switch to a review, discussion…' : ''}
      </Text>
    </View>
  ) : (
    <View style={styles.attachRow}>
      <Pressable
        onPress={() => setSheet('drama')}
        style={[styles.attach, drama ? styles.attachOn : null]}
        accessibilityRole="button"
        accessibilityLabel={drama ? `Drama: ${drama.title}` : 'Attach a drama'}
      >
        {drama ? <Poster drama={drama} width={20} rounded={3} /> : <Ionicons name="film-outline" size={16} color={colors.textSecondary} />}
        <Text variant="label" numberOfLines={1} style={{ maxWidth: 160 }}>
          {drama ? drama.title : needsDrama ? 'Drama (required)' : 'Drama'}
        </Text>
        {drama && !needsDrama ? (
          <Pressable
            onPress={() => {
              setDramaId(undefined);
              setEp(undefined);
              if (spoiler !== 'none') setSpoiler('none');
            }}
            hitSlop={8}
            accessibilityLabel="Remove drama"
          >
            <Ionicons name="close" size={14} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </Pressable>
      {drama ? (
        <Pressable
          onPress={() => setSheet('episode')}
          style={[styles.attach, ep ? styles.attachOn : null]}
          accessibilityRole="button"
          accessibilityLabel={ep?.episode ? `Episode ${ep.episode}` : 'Attach an episode'}
        >
          <Ionicons name="play-circle-outline" size={16} color={colors.textSecondary} />
          <Text variant="label">{ep?.episode ? `${drama.seasons.length > 1 ? `S${ep.season} ` : ''}Ep ${ep.episode}` : ep ? `Season ${ep.season}` : 'Episode'}</Text>
        </Pressable>
      ) : null}
      {type !== 'reaction' ? (
        <Pressable
          onPress={() => setSheet('actors')}
          style={[styles.attach, actorIds.length ? styles.attachOn : null]}
          accessibilityRole="button"
          accessibilityLabel={`Tag actors, ${actorIds.length} selected`}
        >
          <Ionicons name="person-outline" size={16} color={colors.textSecondary} />
          <Text variant="label">{actorIds.length ? `${actorIds.length} actor${actorIds.length > 1 ? 's' : ''}` : 'Actors'}</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => setSheet('spoiler')}
        style={[styles.attach, spoiler !== 'none' ? styles.attachWarn : null]}
        accessibilityRole="button"
        accessibilityLabel={`Spoiler level: ${SPOILER_LABEL[spoiler]}`}
      >
        {spoiler === 'none' ? <Ionicons name="eye-outline" size={16} color={colors.textSecondary} /> : <SpoilerTag level={spoiler} compact />}
        <Text variant="label">{spoiler === 'none' ? 'No spoilers' : spoiler === 'episode' && ep?.episode ? `Ep ${ep.episode} spoiler` : SPOILER_LABEL[spoiler]}</Text>
      </Pressable>
    </View>
  );

  return (
    <Screen
      header={
        <TopBar
          mode="modal"
          title={editing ? `Edit ${meta.label.toLowerCase()}` : meta.label}
          subtitle={drama ? (ep?.episode ? `${drama.title} · Ep ${ep.episode}` : drama.title) : undefined}
          onBack={() => (dirty && !editing ? setLeaveDialog(true) : goBack())}
          right={<Button label={editing ? 'Save' : type === 'review' ? 'Publish' : 'Post'} size="sm" onPress={publish} disabled={!canPost} loading={posting} />}
        />
      }
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.x8 }}>
          {guidelines && auth.status === 'signedIn' ? (
            <View style={styles.guidelines}>
              <Text variant="titleSmall">Before your first post</Text>
              <Text variant="bodySmall" tone="secondary" style={{ marginTop: 4 }}>
                Be kind, keep spoilers tagged, no harassment, no hate, no explicit content, no piracy links. Posts can be reported and removed, and repeat offenders lose posting. By posting you accept
                the Community Guidelines and Terms.
              </Text>
              <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x3 }}>
                <Button
                  label="I agree"
                  size="sm"
                  onPress={() => {
                    dispatch({ type: 'prefs', patch: { guidelinesAccepted: true } });
                    setGuidelines(false);
                  }}
                />
                <Button label="Read guidelines" size="sm" variant="ghost" onPress={() => router.push('/settings/guidelines')} />
              </View>
            </View>
          ) : null}

          {!editing && (type !== 'post' || dirty || contextVisible) ? (
            <ChipRow style={styles.typeRow}>
              {CREATE_TYPES.map((t) => (
                <Chip
                  key={t.type}
                  label={t.label}
                  icon={t.icon}
                  size="sm"
                  selected={t.type === type}
                  onPress={() => {
                    if (t.type !== type) {
                      haptic.select();
                      router.setParams({ type: t.type });
                    }
                  }}
                  accessibilityLabel={`${t.label}: ${t.hint}`}
                />
              ))}
            </ChipRow>
          ) : null}

          <View style={styles.authorRow}>
            <Avatar uri={me.avatarUrl} name={me.displayName} size="md" />
            <View>
              <Text variant="label">{me.displayName}</Text>
              <Text variant="caption" tone="secondary">
                Public · anyone on Hallyu
              </Text>
            </View>
          </View>

          {type === 'reaction' ? (
            <View style={{ paddingHorizontal: space.margin, marginBottom: space.x3 }}>
              <Text variant="overline" style={{ marginBottom: space.x2 }}>
                How did it hit?
              </Text>
              <View style={styles.reactions}>
                {REACTIONS.map((r) => {
                  const on = reactionKind === r.kind;
                  return (
                    <Pressable
                      key={r.kind}
                      onPress={() => {
                        haptic.select();
                        setReactionKind(r.kind);
                      }}
                      style={[styles.reaction, on ? { backgroundColor: colors.accentSoft, borderColor: colors.accent } : null]}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={r.label}
                    >
                      <ReactionGlyph kind={r.kind} size={22} active={on} />
                      <Text variant="caption" tone={on ? 'accent' : 'secondary'}>
                        {r.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {type === 'discussion' ? (
            <View style={{ paddingHorizontal: space.margin }}>
              <ChipRow style={{ marginBottom: space.x3 }}>
                {KINDS.map((k) => (
                  <Chip key={k} label={KIND_LABEL[k]} size="sm" selected={kind === k} onPress={() => setKind(k)} />
                ))}
              </ChipRow>
              <TextInput
                editable={!posting}
                value={title}
                onChangeText={(t) => setTitle(t.slice(0, LIMITS.discussionTitle))}
                placeholder={kind === 'question' ? 'Ask the fandom…' : kind === 'theory' ? 'Your theory in one line' : 'Title'}
                placeholderTextColor={colors.textTertiary}
                style={styles.title}
                selectionColor={colors.accent}
                cursorColor={colors.accent}
                keyboardAppearance="dark"
                returnKeyType="next"
                onSubmitEditing={() => bodyRef.current?.focus()}
                accessibilityLabel="Discussion title"
                maxLength={LIMITS.discussionTitle}
              />
              <Text variant="caption" tone={title.length > LIMITS.discussionTitle - 10 ? 'warm' : 'tertiary'} align="right" numeric>
                {title.length}/{LIMITS.discussionTitle}
              </Text>
            </View>
          ) : null}

          {type === 'review' ? (
            <View style={{ paddingHorizontal: space.margin, gap: space.x3, marginBottom: space.x2 }}>
              {drama && wl?.status !== 'completed' ? (
                <InlineNotice
                  tone="info"
                  icon="information-circle-outline"
                  text={
                    wl?.status === 'watching'
                      ? `You’re on episode ${wl.currentEpisode}. Reviews read best after the finale — mid-run reviews get a “still watching” label.`
                      : 'Reviews from people who finished the drama carry a “completed” badge.'
                  }
                />
              ) : null}
              <View>
                <Text variant="overline" style={{ marginBottom: space.x2 }}>
                  Rating
                </Text>
                <View style={styles.ratingRow}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                    const on = rating !== undefined && n <= rating;
                    return (
                      <Pressable
                        key={n}
                        onPress={() => {
                          haptic.select();
                          setRating(n);
                        }}
                        style={styles.ratingCell}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: rating === n }}
                        accessibilityLabel={`${n} out of 10`}
                      >
                        <Ionicons name={on ? 'star' : 'star-outline'} size={24} color={on ? colors.warm : colors.textTertiary} />
                      </Pressable>
                    );
                  })}
                </View>
                <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
                  {rating ? `${rating}/10 · ${rating >= 9 ? 'Masterpiece' : rating >= 8 ? 'Great' : rating >= 7 ? 'Good' : rating >= 5 ? 'Mixed' : 'Not for me'}` : 'Tap a star'}
                </Text>
              </View>
              <View>
                <TextInput
                  editable={!posting}
                  value={verdict}
                  onChangeText={(t) => setVerdict(t.slice(0, LIMITS.reviewVerdict))}
                  placeholder="One-line verdict (shows on the card)"
                  placeholderTextColor={colors.textTertiary}
                  style={styles.title}
                  selectionColor={colors.accent}
                  cursorColor={colors.accent}
                  keyboardAppearance="dark"
                  accessibilityLabel="Verdict"
                  maxLength={LIMITS.reviewVerdict}
                />
                <Text variant="caption" tone="tertiary" align="right" numeric>
                  {verdict.length}/{LIMITS.reviewVerdict}
                </Text>
              </View>
            </View>
          ) : null}

          {type === 'recommendation' ? (
            <View style={{ paddingHorizontal: space.margin, marginBottom: space.x3 }}>
              <Text variant="overline" style={{ marginBottom: space.x2 }}>
                If you liked…
              </Text>
              <Pressable
                onPress={() => setSheet('secondary')}
                style={styles.secondary}
                accessibilityRole="button"
                accessibilityLabel={secondary ? `Compared to ${secondary.title}` : 'Pick the drama you’re comparing to'}
              >
                {secondary ? <Poster drama={secondary} width={36} rounded={4} /> : <Ionicons name="add-circle-outline" size={22} color={colors.textSecondary} />}
                <View style={{ flex: 1 }}>
                  <Text variant="label">{secondary ? secondary.title : 'Choose a drama they already love'}</Text>
                  <Text variant="caption" tone="secondary">
                    {drama && secondary ? `Then they’ll like ${drama.title}` : 'Recommendations pair two dramas.'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
              </Pressable>
            </View>
          ) : null}

          {type === 'short' ? (
            <View style={{ paddingHorizontal: space.margin, marginBottom: space.x3 }}>
              <Pressable onPress={pickVideo} style={styles.videoBox} accessibilityRole="button" accessibilityLabel={video ? 'Replace video' : 'Add a video'}>
                {video?.poster ? (
                  <>
                    <Image source={{ uri: video.poster }} style={styles.videoPoster} contentFit="cover" accessibilityLabel="Video preview" />
                    <View style={styles.videoScrim} />
                  </>
                ) : null}
                {video ? (
                  <>
                    <Ionicons name="videocam" size={28} color={colors.onMedia} />
                    <Text variant="label" tone="onMedia">
                      {video.duration}s · vertical
                    </Text>
                    <Text variant="caption" tone="onMedia">
                      Tap to replace
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="videocam-outline" size={28} color={colors.textSecondary} />
                    <Text variant="label">Add a video</Text>
                    <Text variant="caption" tone="secondary">
                      3–60 seconds · 9:16 works best
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space.margin }}>
            <TextInput
              editable={!posting}
              ref={bodyRef}
              value={body}
              onChangeText={(t) => setBody(t)}
              multiline
              autoFocus={type !== 'discussion' && type !== 'short' && !params.tag}
              placeholder={
                type === 'reaction'
                  ? drama
                    ? `One line on ${drama.title}${ep?.episode ? ` Ep ${ep.episode}` : ''}…`
                    : 'One line. Pick a drama first.'
                  : type === 'discussion'
                    ? 'Lay it out. Quote the scene, timestamp it, ask the question.'
                    : type === 'review'
                      ? 'The longer take — what worked, what didn’t, who to watch it with. Optional.'
                      : type === 'recommendation'
                        ? 'Why does this pairing work?'
                        : type === 'short'
                          ? 'Caption'
                          : 'What’s on your mind? #hashtags and @mentions work.'
              }
              placeholderTextColor={colors.textTertiary}
              style={[styles.body, { minHeight: type === 'reaction' ? 80 : type === 'discussion' || type === 'review' ? 200 : 140 }]}
              selectionColor={colors.accent}
              cursorColor={colors.accent}
              keyboardAppearance="dark"
              textAlignVertical="top"
              accessibilityLabel="Body"
            />
            <Text variant="caption" tone={body.length > bodyLimit ? 'danger' : body.length > bodyLimit * 0.9 ? 'warm' : 'tertiary'} align="right" numeric>
              {body.length}/{bodyLimit}
            </Text>
            {mentionMatches.length ? (
              <View style={styles.mentions}>
                {mentionMatches.map((u) => (
                  <Pressable
                    key={u.id}
                    onPress={() => setBody((t) => t.replace(/@(\w*)$/, `@${u.handle} `))}
                    style={styles.mentionRow}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${u.displayName}`}
                  >
                    <Avatar uri={u.avatarUrl} name={u.displayName} size="xs" />
                    <Text variant="label">{u.displayName}</Text>
                    <Text variant="caption" tone="secondary">
                      @{u.handle}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>

          {pollOpen && (type === 'post' || type === 'discussion') ? (
            <View style={{ paddingHorizontal: space.margin, marginTop: space.x3 }}>
              <View style={{ padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, gap: space.x2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="stats-chart" size={14} color={colors.accent} />
                    <Text variant="overline" tone="accent">
                      INTERACTIVE POLL
                    </Text>
                  </View>
                  <Pressable onPress={() => setPollOpen(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove poll">
                    <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                  </Pressable>
                </View>
                <TextInput
                  editable={!posting}
                  value={pollQuestion}
                  onChangeText={(t) => setPollQuestion(t.slice(0, 140))}
                  placeholder="Ask a question (e.g. Who stole Episode 10?)"
                  placeholderTextColor={colors.textTertiary}
                  style={{ color: colors.textPrimary, fontSize: 15, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle }}
                />
                {pollOptions.map((opt, idx) => (
                  <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                    <TextInput
                      editable={!posting}
                      value={opt}
                      onChangeText={(t) =>
                        setPollOptions((prev) => prev.map((item, i) => (i === idx ? t.slice(0, 80) : item)))
                      }
                      placeholder={`Choice ${idx + 1}${idx < 2 ? ' (required)' : ' (optional)'}`}
                      placeholderTextColor={colors.textTertiary}
                      style={{ flex: 1, color: colors.textPrimary, fontSize: 14, paddingHorizontal: space.x3, paddingVertical: 9, borderRadius: radius.sm, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle }}
                    />
                    {pollOptions.length > 2 ? (
                      <Pressable
                        onPress={() => setPollOptions((prev) => prev.filter((_, i) => i !== idx))}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove choice ${idx + 1}`}
                      >
                        <Ionicons name="remove-circle-outline" size={18} color={colors.textTertiary} />
                      </Pressable>
                    ) : null}
                  </View>
                ))}
                {pollOptions.length < 4 ? (
                  <Pressable
                    onPress={() => setPollOptions((prev) => [...prev, ''])}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 }}
                    accessibilityRole="button"
                    accessibilityLabel="Add poll option"
                  >
                    <Ionicons name="add-circle-outline" size={16} color={colors.accent} />
                    <Text variant="label" tone="accent">
                      Add choice ({pollOptions.length}/4)
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {images.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2, marginTop: space.x2 }}>
              {images.map((uri) => (
                <View key={uri} style={styles.thumbWrap}>
                  <Image source={{ uri }} style={styles.thumb} contentFit="cover" accessibilityLabel="Attached image" />
                  <Pressable onPress={() => setImages((p) => p.filter((x) => x !== uri))} style={styles.thumbRemove} accessibilityRole="button" accessibilityLabel="Remove image">
                    <Ionicons name="close" size={14} color={colors.onMedia} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {video && type !== 'short' ? (
            <View style={{ paddingHorizontal: space.margin, marginTop: space.x2 }}>
              <View style={styles.videoChip}>
                <Ionicons name="videocam" size={18} color={colors.textPrimary} />
                <View style={{ flex: 1 }}>
                  <Text variant="label">Video attached</Text>
                  <Text variant="caption" tone="secondary">
                    {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, '0')} · plays inline in the feed
                  </Text>
                </View>
                <Pressable onPress={() => setVideo(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove video" style={styles.tool}>
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            </View>
          ) : null}

          {actorIds.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2, marginTop: space.x3 }}>
              {actorIds.map((id) => {
                const a = allActors(state).find((x) => x.id === id);
                return a ? (
                  <View key={id} style={styles.actorChip}>
                    <ActorPortrait actor={a} size={22} />
                    <Text variant="caption">{a.name}</Text>
                    <Pressable onPress={() => setActorIds((p) => p.filter((x) => x !== id))} hitSlop={8} accessibilityLabel={`Remove ${a.name}`}>
                      <Ionicons name="close" size={12} color={colors.textSecondary} />
                    </Pressable>
                  </View>
                ) : null;
              })}
            </ScrollView>
          ) : null}

          {hint ? (
            <View style={styles.hint} accessibilityRole="alert">
              <Ionicons name="eye-off-outline" size={16} color={colors.warning} />
              <Text variant="caption" style={{ flex: 1 }}>
                {hint.reason} Mark it as {hint.level === 'ending' ? 'an ending' : hint.level === 'season' ? 'a season' : 'an episode'} spoiler?
              </Text>
              <Pressable
                onPress={() => {
                  haptic.select();
                  setSpoiler(hint.level);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Mark as ${hint.level} spoiler`}
              >
                <Text variant="label" tone="accent">
                  Mark it
                </Text>
              </Pressable>
              <Pressable onPress={() => setIgnoreHint(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                <Ionicons name="close" size={14} color={colors.textTertiary} />
              </Pressable>
            </View>
          ) : null}
          {problems.length && dirty ? (
            <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: space.margin, marginTop: space.x3 }}>
              {problems[0]}
            </Text>
          ) : null}
        </ScrollView>

        {posting && stage ? <PublishProgress stage={stage} /> : null}

        <View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, space.x2) }]}>
          {/* Nothing in the toolbar can change the post while it is being published: the post row and
              the file list are already fixed, so an edit here would be dropped without saying so. */}
          <View pointerEvents={posting ? 'none' : 'auto'} style={posting ? styles.inert : undefined}>
            {attachRow}
          </View>
          <View pointerEvents={posting ? 'none' : 'auto'} style={[posting ? styles.inert : undefined, { flexDirection: 'row', alignItems: 'center', gap: space.x1 }]}>
            {type !== 'short' && type !== 'reaction' ? (
              <Pressable
                onPress={pickImages}
                disabled={images.length >= LIMITS.images}
                style={styles.tool}
                accessibilityRole="button"
                accessibilityLabel={`Add images, ${images.length} of ${LIMITS.images}`}
              >
                <Ionicons name="image-outline" size={22} color={images.length >= LIMITS.images ? colors.textDisabled : colors.textPrimary} />
              </Pressable>
            ) : null}
            {type === 'post' || type === 'discussion' ? (
              <Pressable onPress={pickVideo} style={styles.tool} accessibilityRole="button" accessibilityLabel={video ? 'Replace video' : 'Add a video'}>
                <Ionicons name={video ? 'videocam' : 'videocam-outline'} size={22} color={video ? colors.accentText : colors.textPrimary} />
              </Pressable>
            ) : null}
            {type === 'post' || type === 'discussion' ? (
              <Pressable
                onPress={() => {
                  haptic.select();
                  setPollOpen((v) => !v);
                }}
                style={styles.tool}
                accessibilityRole="button"
                accessibilityLabel={pollOpen ? 'Remove poll' : 'Add interactive poll'}
              >
                <Ionicons name={pollOpen ? 'stats-chart' : 'stats-chart-outline'} size={21} color={pollOpen ? colors.accent : colors.textPrimary} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => setBody((b) => `${b}${b.endsWith(' ') || !b ? '' : ' '}#`)} style={styles.tool} accessibilityRole="button" accessibilityLabel="Add hashtag">
              <Text variant="titleSmall">#</Text>
            </Pressable>
            <Pressable onPress={() => setBody((b) => `${b}${b.endsWith(' ') || !b ? '' : ' '}@`)} style={styles.tool} accessibilityRole="button" accessibilityLabel="Mention someone">
              <Text variant="titleSmall">@</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            {!editing ? (
              <Button
                label="Save draft"
                variant="ghost"
                size="sm"
                disabled={!dirty}
                onPress={() => {
                  saveDraft();
                  toast.show({ message: 'Draft saved' });
                }}
              />
            ) : null}
            <Pressable onPress={Keyboard.dismiss} style={styles.tool} accessibilityRole="button" accessibilityLabel="Hide keyboard">
              <Ionicons name="chevron-down" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <DramaPickerSheet
        visible={sheet === 'drama'}
        onClose={() => setSheet(null)}
        onPick={(d) => {
          setDramaId(d.id);
          if (d.id !== dramaId) setEp(undefined);
        }}
      />
      <DramaPickerSheet visible={sheet === 'secondary'} onClose={() => setSheet(null)} onPick={(d) => setSecondaryId(d.id)} title="If they liked…" exclude={dramaId} />
      {drama ? (
        <EpisodePickerSheet
          visible={sheet === 'episode'}
          onClose={() => setSheet(null)}
          drama={drama}
          value={ep}
          onPick={(v) => {
            setEp(v);
            if (v?.episode && spoiler === 'none' && type !== 'review') setSpoiler('episode');
          }}
        />
      ) : null}
      <ActorPickerSheet visible={sheet === 'actors'} onClose={() => setSheet(null)} selected={actorIds} onChange={setActorIds} dramaId={dramaId} />
      <SpoilerSheet visible={sheet === 'spoiler'} onClose={() => setSheet(null)} value={spoiler} onChange={setSpoiler} drama={drama} episode={ep?.episode} />
      <VideoAccessSheet
        visible={videoAccessOpen}
        onClose={() => setVideoAccessOpen(false)}
        initialStatus={videoAccess}
        onStatusChange={setVideoAccess}
      />
      <Dialog
        visible={leaveDialog}
        title="Keep this as a draft?"
        body="Drafts stay on this device until you post or delete them."
        confirmLabel="Save draft"
        cancelLabel="Keep editing"
        onConfirm={() => leave(true)}
        onCancel={() => setLeaveDialog(false)}
      >
        <Button label="Discard" variant="ghost" onPress={() => leave(false)} />
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  inert: { opacity: 0.5 },
  publish: {
    gap: space.x2,
    marginHorizontal: space.margin,
    marginBottom: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  guidelines: { margin: space.margin, marginBottom: 0, padding: space.x4, backgroundColor: colors.surface1, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    marginHorizontal: space.margin,
    marginTop: space.x3,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  typeRow: { paddingHorizontal: space.margin, paddingTop: space.x3 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingHorizontal: space.margin, paddingVertical: space.x4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  reaction: {
    width: '31%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  title: { color: colors.textPrimary, fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, paddingVertical: space.x2 },
  body: { color: colors.textPrimary, fontFamily: fonts.regular, fontSize: 17, lineHeight: 26, paddingVertical: space.x2 },
  ratingRow: { flexDirection: 'row', justifyContent: 'space-between' },
  ratingCell: { width: 30, height: 40, alignItems: 'center', justifyContent: 'center' },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: space.x3, padding: space.x3, backgroundColor: colors.surface1, borderRadius: radius.md },
  videoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  videoBox: {
    height: 160,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    overflow: 'hidden',
  },
  videoPoster: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  videoScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.45)' },
  thumbWrap: { width: 96, height: 120, borderRadius: radius.sm, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
  thumbRemove: { position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(10,10,10,0.7)', alignItems: 'center', justifyContent: 'center' },
  actorChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4, paddingRight: 10, height: 32, borderRadius: 16, backgroundColor: colors.surface2 },
  mentions: { backgroundColor: colors.surface2, borderRadius: radius.md, overflow: 'hidden', marginTop: space.x2 },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingHorizontal: space.x3, height: 40 },
  toolbar: { borderTopWidth: 1, borderTopColor: colors.borderSubtle, backgroundColor: colors.canvas, paddingHorizontal: space.x2, paddingTop: space.x2, gap: space.x2 },
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2, paddingHorizontal: space.x2 },
  attach: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  attachOn: { borderColor: colors.borderStrong, backgroundColor: colors.surface2 },
  attachWarn: { borderColor: colors.warm, backgroundColor: colors.surface2 },
  tool: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
