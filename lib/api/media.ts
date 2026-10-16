/**
 * The backend media pipeline — the only way media reaches a post.
 *
 * The composer used to keep the device's own `file://` URI on the post and call that "posted".
 * That is exactly the failure this module exists to remove: the bytes lived on one phone, the
 * server had no `post_media` row and no object in the bucket, and any other member's client could
 * only see a broken image. A video post now has to survive the whole round trip before the composer
 * is allowed to say it succeeded:
 *
 *   begin_media_upload   → reserve the path (migration 30) so a crash mid-upload still leaves a row
 *   storage upload        → the actual bytes, into the member's own `u/<uid>/…` folder
 *   complete_media_upload → attach to the post, creating the post_media row
 *   verifyPostMedia       → read post_media back and prove OUR paths are attached
 *
 * The verification step is not decoration. `complete_media_upload` can succeed while the composer
 * still holds a device URI, and only the round trip proves the server can render the post. Every
 * failure throws `MediaPipelineError`, which the composer turns into "not posted" + a kept draft.
 */
import * as FileSystem from 'expo-file-system';
import { FileSystemUploadType } from 'expo-file-system';
import { Platform } from 'react-native';
import { MEDIA_BUCKET, SUPABASE_ANON_KEY, SUPABASE_URL } from '../../constants/keys';
import { getBackendAccessToken, supabase } from './client';
import { isUuid } from './social';

/** A step of the pipeline failed. `step` names which one, so the message can be specific. */
export class MediaPipelineError extends Error {
  readonly step: 'begin' | 'upload' | 'complete' | 'verify' | 'cleanup';
  constructor(step: MediaPipelineError['step'], message: string) {
    super(message);
    this.name = 'MediaPipelineError';
    this.step = step;
  }
}

export type MediaKind = 'image' | 'video';

/** Bytes of a file that have left the device, reported while an upload is in flight. */
export interface UploadProgress {
  sent: number;
  /** 0 until the transport reports a total, which is why the composer treats it as unknown until then. */
  total: number;
}

/** One reserved-and-uploaded object, before it is attached to a post. */
export interface UploadedAsset {
  uploadId: string;
  storagePath: string;
  kind: MediaKind;
  /** Set for video: the separately-uploaded poster frame's storage path. */
  posterPath?: string;
}

const EXT: Record<MediaKind, string> = { image: 'jpg', video: 'mp4' };
const CONTENT_TYPE: Record<MediaKind, string> = { image: 'image/jpeg', video: 'video/mp4' };

function extensionFor(uri: string, kind: MediaKind): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(uri);
  const ext = m?.[1]?.toLowerCase();
  // Only trust an extension we would actually serve as the declared content type.
  if (ext && ((kind === 'image' && ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) || (kind === 'video' && ['mp4', 'mov', 'm4v', 'webm'].includes(ext)))) {
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  return EXT[kind];
}

/** Storage paths must start `u/<auth.uid()>/…` — `storage_owner()` and the RLS policy both enforce it. */
export function assetPath(userId: string, kind: MediaKind, uri: string, unique: string): string {
  return `u/${userId}/${unique}.${extensionFor(uri, kind)}`;
}

function requireUploadEnv(): { url: string; key: string; token: string } {
  const token = getBackendAccessToken();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new MediaPipelineError('upload', 'The backend is not configured in this build.');
  if (!token) throw new MediaPipelineError('upload', 'Sign in before uploading media.');
  if (!supabase) throw new MediaPipelineError('upload', 'The backend is not configured in this build.');
  return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY, token };
}

/**
 * Upload one local file to the private bucket, reporting bytes as they leave the device.
 *
 * `FileSystem.uploadAsync` streams the file off disk rather than base64-ing it through JS memory,
 * which is what makes a 140MB clip survivable on a phone; supabase-js's `.upload()` would first
 * buffer the whole thing. It reports nothing while it runs, though, so native goes through
 * `createUploadTask` instead — the same transfer with a progress callback — and the web build, where
 * no `expo-file-system` upload exists at all, sends the picked file's Blob through XHR, whose
 * `upload.onprogress` reports the same numbers. The anon key is a publishable credential by design,
 * and the member's own access token is what authorises the write — the service-role key is never
 * involved here and is never present in a client bundle.
 */
async function putObject(
  storagePath: string,
  fileUri: string,
  contentType: string,
  onProgress?: (progress: UploadProgress) => void,
  preloaded?: Blob | null,
): Promise<void> {
  const { url, key, token } = requireUploadEnv();
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
  const endpoint = `${url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    apikey: key,
    'x-upsert': 'true',
    'Content-Type': contentType,
  };

  // Supabase Storage answers 200 (upsert) or 201 (create). Anything else is a real failure.
  if (Platform.OS === 'web') {
    const { status, body } = await putObjectViaXhr(endpoint, headers, fileUri, onProgress, preloaded);
    if (status < 200 || status >= 300) {
      throw new MediaPipelineError('upload', `The upload was refused by storage (HTTP ${status}). ${body}`);
    }
    return;
  }

  const task = FileSystem.createUploadTask(
    endpoint,
    fileUri,
    { httpMethod: 'POST', uploadType: FileSystemUploadType.BINARY_CONTENT, headers },
    (p) => {
      // `totalBytesExpectedToSend` is 0 until the transport knows the body length; reporting
      // "0 of 0" would read as progress when it is the opposite.
      if (p.totalBytesExpectedToSend > 0) onProgress?.({ sent: p.totalBytesSent, total: p.totalBytesExpectedToSend });
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    const body = typeof result?.body === 'string' ? result.body.slice(0, 200) : '';
    throw new MediaPipelineError('upload', `The upload was refused by storage (HTTP ${result?.status ?? 0}). ${body}`);
  }
}

/** Web transport: XHR is the only browser API that reports how much of a body has been sent. */
function putObjectViaXhr(
  endpoint: string,
  headers: Record<string, string>,
  fileUri: string,
  onProgress?: (progress: UploadProgress) => void,
  preloaded?: Blob | null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const blob = preloaded ?? (await (await fetch(fileUri)).blob());
        const xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress?.({ sent: e.loaded, total: e.total });
        };
        xhr.onload = () => resolve({ status: xhr.status, body: typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, 200) : '' });
        xhr.onerror = () => reject(new MediaPipelineError('upload', 'The upload connection failed.'));
        xhr.onabort = () => reject(new MediaPipelineError('upload', 'The upload was cancelled.'));
        xhr.send(blob);
      } catch (e) {
        reject(e instanceof MediaPipelineError ? e : new MediaPipelineError('upload', `The upload did not complete. ${(e as Error).message}`));
      }
    })();
  });
}

/**
 * How many bytes a local file holds, or `null` when the platform will not say.
 *
 * This is not cosmetic: `begin_media_upload` can only refuse an upload that would break the monthly
 * video allowance if it is told the size, so the composer asks for it before reserving the path.
 * The uploader reports the real size as it goes, and the server reconciles against the object's
 * stored size when the file is attached — a declared size is a hint, never the last word.
 */
async function localBytes(uri: string): Promise<{ size: number | null; blob: Blob | null }> {
  try {
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      return { size: blob.size > 0 ? blob.size : null, blob };
    }
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    return { size: info.exists && typeof info.size === 'number' ? info.size : null, blob: null };
  } catch {
    return { size: null, blob: null };
  }
}

/** Reserve the path and send the bytes. Returns what `complete_media_upload` will need. */
export async function uploadAsset(opts: {
  userId: string;
  uri: string;
  kind: MediaKind;
  byteSize?: number | null;
  unique: string;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadedAsset> {
  const { userId, uri, kind, unique, onProgress } = opts;
  requireUploadEnv();
  const path = assetPath(userId, kind, uri, unique);
  const local = opts.byteSize ? { size: opts.byteSize, blob: null } : await localBytes(uri);

  // These RPCs return a scalar uuid, so the value comes back directly rather than as a row —
  // asking for `.single()` here would be a shape mismatch, not a stricter check.
  const { data, error } = await supabase!
    .rpc('begin_media_upload', {
      p_storage_path: path,
      p_kind: kind,
      p_byte_size: local.size ?? null,
      p_content_type: CONTENT_TYPE[kind],
    });
  const uploadId = data as string | null;
  if (error || !uploadId) throw new MediaPipelineError('begin', `The server would not reserve the upload path. ${error?.message ?? 'no id returned'}`);

  try {
    await putObject(path, uri, CONTENT_TYPE[kind], onProgress, local.blob);
  } catch (e) {
    throw e instanceof MediaPipelineError ? e : new MediaPipelineError('upload', `The upload did not complete. ${(e as Error).message}`);
  }

  return { uploadId, storagePath: path, kind };
}

/** Upload a video's poster frame as its own object; its path is recorded on the video's row. */
export async function uploadPoster(opts: { userId: string; posterUri: string; unique: string }): Promise<string> {
  const { userId, posterUri, unique } = opts;
  requireUploadEnv();
  const path = assetPath(userId, 'image', posterUri, `${unique}-poster`);
  const { data, error } = await supabase!
    .rpc('begin_media_upload', { p_storage_path: path, p_kind: 'image', p_byte_size: null, p_content_type: 'image/jpeg' });
  const posterUploadId = data as string | null;
  if (error || !posterUploadId) throw new MediaPipelineError('begin', `The server would not reserve the poster path. ${error?.message ?? 'no id returned'}`);
  await putObject(path, posterUri, 'image/jpeg');
  // No post yet: confirming without one leaves the row pending with a 30-day window, which is
  // what "upload the poster first, attach it when the post exists" needs.
  const { error: completeError } = await supabase!.rpc('complete_media_upload', {
    p_upload_id: posterUploadId,
    p_post_id: null,
    p_position: null,
    p_width: null,
    p_height: null,
    p_duration_ms: null,
    p_poster_path: null,
  });
  if (completeError) throw new MediaPipelineError('complete', `The poster was uploaded but not registered. ${completeError.message}`);
  return path;
}

/** Attach an uploaded asset to its post, which is what creates the `post_media` row. */
export async function attachAsset(opts: {
  uploadId: string;
  postId: string;
  position?: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  posterPath?: string | null;
}): Promise<string> {
  requireUploadEnv();
  const { data, error } = await supabase!.rpc('complete_media_upload', {
    p_upload_id: opts.uploadId,
    p_post_id: opts.postId,
    p_position: opts.position ?? null,
    p_width: opts.width ?? null,
    p_height: opts.height ?? null,
    p_duration_ms: opts.durationMs ?? null,
    p_poster_path: opts.posterPath ?? null,
  });
  if (error) throw new MediaPipelineError('complete', `The upload was not attached to the post. ${error.message}`);
  const mediaId = (data as string | null) ?? null;
  if (!mediaId) throw new MediaPipelineError('complete', 'The server did not return a media id for the attachment.');
  return mediaId;
}

/**
 * Read `post_media` back for the post and prove the assets we uploaded are really attached.
 *
 * This is the step that stops a video from being reported as posted when the server has no record
 * of it. A composer may only claim success once every expected storage path is found here.
 */
export async function verifyPostMedia(postId: string, expected: string[]): Promise<void> {
  if (!expected.length) return;
  if (!isUuid(postId)) throw new MediaPipelineError('verify', 'The post id is not a server id, so its media cannot be verified.');
  const { data, error } = await supabase!.from('post_media').select('storage_path, poster_path').eq('post_id', postId);
  if (error) throw new MediaPipelineError('verify', `The attached media could not be read back. ${error.message}`);
  const found = new Set<string>();
  for (const row of (data ?? []) as { storage_path: string | null; poster_path: string | null }[]) {
    if (row.storage_path) found.add(row.storage_path);
    if (row.poster_path) found.add(row.poster_path);
  }
  const missing = expected.filter((p) => !found.has(p));
  if (missing.length) {
    throw new MediaPipelineError('verify', `The server did not attach ${missing.length} of ${expected.length} file(s) to the post, so it is not saved.`);
  }
}

/**
 * Best-effort removal of objects uploaded for a post that then failed. Never throws: this runs on
 * the failure path, where adding a second error would hide the first. The backend's own retention
 * job is the backstop if this cannot run.
 */
export async function discardAssets(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await supabase?.storage.from(MEDIA_BUCKET).remove(paths);
  } catch {
    // Nothing to do — media_remove_orphans / the removal queue will collect it.
  }
}

// ── Reading media back ─────────────────────────────────────────────────────────────────────────

/** One row of `post_media`, as the client needs it. */
export interface PostMedia {
  kind: MediaKind;
  storagePath: string;
  posterPath: string | null;
  position: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** `post_media` rows for a set of posts. RLS limits this to posts the member may see. */
export async function fetchPostMedia(postIds: string[]): Promise<Map<string, PostMedia[]>> {
  const byPost = new Map<string, PostMedia[]>();
  const uuids = [...new Set(postIds.filter(isUuid))];
  if (!uuids.length || !supabase) return byPost;
  const { data, error } = await supabase
    .from('post_media')
    .select('post_id, kind, storage_path, poster_path, position, width, height, duration_ms')
    .in('post_id', uuids)
    .order('position', { ascending: true });
  if (error) throw new MediaPipelineError('verify', `Post media could not be read. ${error.message}`);
  for (const row of (data ?? []) as {
    post_id: string;
    kind: MediaKind;
    storage_path: string;
    poster_path: string | null;
    position: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  }[]) {
    const list = byPost.get(row.post_id) ?? [];
    list.push({ kind: row.kind, storagePath: row.storage_path, posterPath: row.poster_path, position: row.position, width: row.width, height: row.height, durationMs: row.duration_ms });
    byPost.set(row.post_id, list);
  }
  for (const list of byPost.values()) list.sort((a, b) => a.position - b.position);
  return byPost;
}

const SIGNED_TTL_SECONDS = 3600;
/** Signed URLs expire, so they are cached only until shortly before they do. */
const signedCache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Storage paths → signed URLs.
 *
 * The `media` bucket is private, so a post adopted from the backend carries only storage paths and
 * is unrenderable until it is signed. Without this the cache would silently show posts with no
 * images after adoption, which looks exactly like "the media upload failed" to the member.
 */
export async function signedUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length || !supabase) return out;
  const now = Date.now();
  const wanted: string[] = [];
  for (const path of paths) {
    const hit = signedCache.get(path);
    if (hit && hit.expiresAt > now) out.set(path, hit.url);
    else if (!hit) wanted.push(path);
  }
  if (wanted.length) {
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(wanted, SIGNED_TTL_SECONDS);
    if (error) throw new MediaPipelineError('verify', `Media could not be signed for display. ${error.message}`);
    for (const row of (data ?? []) as { path: string; signedURL: string | null }[]) {
      if (!row.signedURL) continue;
      // Re-sign a minute early: a URL that expires mid-scroll is worse than one fetched again.
      signedCache.set(row.path, { url: row.signedURL, expiresAt: now + (SIGNED_TTL_SECONDS - 60) * 1000 });
      out.set(row.path, row.signedURL);
    }
  }
  return out;
}