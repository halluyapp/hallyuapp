import type { Post } from './model';

/**
 * Atomic / safely recoverable media-post publishing coordinator (`runAtomicPostPublishPipeline`).
 *
 * Enforces every integrity invariant across upload -> insert -> attach -> verify -> read-back:
 *   1. Text-only posts are untouched (handled directly outside media upload stages).
 *   2. Reuses a caller-supplied stable `postId` across retries of the same draft/attempt so a retry
 *      never creates duplicate feed posts.
 *   3. Tracks ONLY storage object paths uploaded during THIS attempt (`attemptUploadedPaths`) AND
 *      whether `insertPost` succeeded in THIS attempt (`postRowCreated`).
 *   4. If upload or `insertPost` fails BEFORE post creation finishes: discards ONLY `attemptUploadedPaths`
 *      and leaves all existing posts untouched.
 *   5. If `attachAsset`, `verifyPostMedia`, or server `fetchPosts([post.id])` read-back fails AFTER
 *      `insertPost` succeeded: rolls back BOTH the incomplete `posts` row (`cleanupUnpublishedPost(post.id)`)
 *      AND `attemptUploadedPaths` (`discardAssets`), leaving zero active media-less posts and zero
 *      orphaned storage blobs.
 *   6. Returns ONLY the verified read-back post confirmed to carry the attached media.
 */

export interface StagedUploadedImage {
  uploadId: string;
  storagePath: string;
  width: number;
  height: number;
}

export interface StagedUploadedVideo {
  uploadId: string;
  storagePath: string;
  posterPath: string | null;
  width: number | null;
  height: number | null;
  durationMs: number;
}

export interface MediaPublishPipelineInput {
  post: Post;
  userId: string;
  world: string | null;
  poll?: Post['poll'];
  imageUris: string[];
  videoInput: {
    url: string;
    poster?: string;
    durationSec: number;
  } | null;
  onPhase?: (phase: 'upload' | 'insert' | 'attach' | 'verify') => void;
}

export interface MediaPublishPipelineDeps {
  uploadImage: (
    userId: string,
    postId: string,
    uri: string,
    index: number,
  ) => Promise<StagedUploadedImage>;
  uploadVideo: (
    userId: string,
    postId: string,
    uri: string,
    durationMs: number,
  ) => Promise<{
    uploadId: string;
    storagePath: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  }>;
  uploadPoster: (userId: string, postId: string, posterUri: string) => Promise<string>;
  insertPost: (post: Post, userId: string, world: string | null) => Promise<void>;
  attachAsset: (opts: {
    uploadId: string;
    postId: string;
    position: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    posterPath?: string | null;
  }) => Promise<string>;
  verifyPostMedia: (postId: string, expectedPaths: string[]) => Promise<void>;
  fetchPosts: (ids: string[]) => Promise<Post[]>;
  cleanupUnpublishedPost: (postId: string) => Promise<void>;
  discardAssets: (paths: string[]) => Promise<void>;
}

export async function runAtomicPostPublishPipeline(
  input: MediaPublishPipelineInput,
  deps: MediaPublishPipelineDeps,
): Promise<Post> {
  const { post, userId, world, poll, imageUris, videoInput, onPhase } = input;
  const attemptUploadedPaths: string[] = [];
  let postRowCreated = false;

  try {
    onPhase?.('upload');
    const stagedImages: StagedUploadedImage[] = [];
    for (let i = 0; i < imageUris.length; i++) {
      const staged = await deps.uploadImage(userId, post.id, imageUris[i]!, i);
      attemptUploadedPaths.push(staged.storagePath);
      stagedImages.push(staged);
    }

    let stagedVideo: StagedUploadedVideo | null = null;
    if (videoInput) {
      const durationMs = Math.max(1000, Math.round(videoInput.durationSec * 1000));
      const vid = await deps.uploadVideo(userId, post.id, videoInput.url, durationMs);
      attemptUploadedPaths.push(vid.storagePath);

      let posterPath: string | null = null;
      if (videoInput.poster && !/^https?:\/\//i.test(videoInput.poster)) {
        posterPath = await deps.uploadPoster(userId, post.id, videoInput.poster);
        attemptUploadedPaths.push(posterPath);
      }
      stagedVideo = {
        uploadId: vid.uploadId,
        storagePath: vid.storagePath,
        posterPath,
        width: vid.width,
        height: vid.height,
        durationMs: vid.durationMs ?? durationMs,
      };
    }

    onPhase?.('insert');
    await deps.insertPost(post, userId, world);
    postRowCreated = true;

    onPhase?.('attach');
    for (let i = 0; i < stagedImages.length; i++) {
      const img = stagedImages[i]!;
      await deps.attachAsset({
        uploadId: img.uploadId,
        postId: post.id,
        position: i,
        width: img.width,
        height: img.height,
        durationMs: null,
      });
    }
    if (stagedVideo) {
      await deps.attachAsset({
        uploadId: stagedVideo.uploadId,
        postId: post.id,
        position: stagedImages.length,
        width: stagedVideo.width,
        height: stagedVideo.height,
        durationMs: stagedVideo.durationMs,
        posterPath: stagedVideo.posterPath,
      });
    }

    onPhase?.('verify');
    await deps.verifyPostMedia(post.id, attemptUploadedPaths);

    const fetched = await deps.fetchPosts([post.id]);
    const confirmed = fetched[0];
    if (!confirmed) {
      throw new Error('Post read-back returned no row after media attachment.');
    }
    if (stagedImages.length > 0 && (!confirmed.imagePaths || confirmed.imagePaths.length < stagedImages.length)) {
      throw new Error('Post read-back was missing attached images.');
    }
    if (stagedVideo && !confirmed.video?.storagePath && !confirmed.video?.url) {
      throw new Error('Post read-back was missing attached video.');
    }

    return poll ? { ...confirmed, poll: confirmed.poll ?? poll } : confirmed;
  } catch (err) {
    if (postRowCreated) {
      await deps.cleanupUnpublishedPost(post.id).catch(() => {});
    }
    if (attemptUploadedPaths.length > 0) {
      await deps.discardAssets(attemptUploadedPaths).catch(() => {});
    }
    throw err;
  }
}
