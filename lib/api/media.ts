/**
 * The backend media pipeline — the only way media reaches a post or profile avatar.
 *
 *   begin_media_upload    → reserve the path (migration 30) so a crash mid-upload still leaves a row
 *   storage upload         → the actual bytes, into the member's own `u/<uid>/…` folder
 *   complete_media_upload  → attach to the post, creating the post_media row
 *   verifyPostMedia        → read post_media back and prove OUR paths are attached
 *
 * Every private storage path is signed with a full HTTPS URL (`row.signedUrl` + explicit scheme/host
 * normalization) so Android Glide and iOS native decoders never receive a bare `/object/sign/...` path.
 */
import * as FileSystem from 'expo-file-system';
import { FileSystemUploadType } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { MEDIA_BUCKET, SUPABASE_ANON_KEY, SUPABASE_URL } from '../../constants/keys';
import { ensureBackendSessionToken, normalizeMediaUrl, supabase } from './client';
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
  width?: number | null;
  height?: number | null;
  /** Set for video: the separately-uploaded poster frame's storage path. */
  posterPath?: string;
}

const EXT: Record<MediaKind, string> = { image: 'jpg', video: 'mp4' };
const CONTENT_TYPE: Record<MediaKind, string> = { image: 'image/jpeg', video: 'video/mp4' };

function extensionFor(uri: string, kind: MediaKind): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(uri);
  const ext = m?.[1]?.toLowerCase();
  if (
    ext &&
    ((kind === 'image' && ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) ||
      (kind === 'video' && ['mp4', 'mov', 'm4v', 'webm'].includes(ext)))
  ) {
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  return EXT[kind];
}

/** Storage paths must start `u/<auth.uid()>/…` — `storage_owner()` and the RLS policy both enforce it. */
export function assetPath(userId: string, kind: MediaKind, uri: string, unique: string): string {
  return `u/${userId}/${unique}.${extensionFor(uri, kind)}`;
}

async function requireUploadEnv(): Promise<{ url: string; key: string; token: string }> {
  const token = await ensureBackendSessionToken();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new MediaPipelineError('upload', 'The backend is not configured in this build.');
  }
  if (!token) {
    throw new MediaPipelineError('upload', 'Sign in before uploading media.');
  }
  if (!supabase) {
    throw new MediaPipelineError('upload', 'The backend is not configured in this build.');
  }
  return { url: SUPABASE_URL.replace(/\/$/, ''), key: SUPABASE_ANON_KEY, token };
}

/**
 * Ensures any Android `content://...` picker URI (Photo Picker, Google Photos, Samsung Gallery)
 * is copied into a standard local `file://` cache file before `getInfoAsync` or `createUploadTask`.
 */
async function ensureUploadableLocalUri(uri: string, ext: string): Promise<string> {
  if (Platform.OS === 'web' || uri.startsWith('file://') || /^https?:\/\//i.test(uri)) {
    return uri;
  }
  try {
    const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    if (!dir) return uri;
    const target = `${dir}hallyu-upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  } catch {
    return uri;
  }
}

/**
 * Converts a picked image (`content://`, `.heic`, `.png`, large camera photo) into a clean,
 * orientation-baked JPEG `file://` asset with known `width` and `height`.
 */
export async function prepareLocalImage(
  uri: string,
  maxWidth = 1600,
): Promise<{ uri: string; width: number | null; height: number | null }> {
  if (Platform.OS === 'web') {
    return { uri, width: null, height: null };
  }
  try {
    const localUri = await ensureUploadableLocalUri(uri, extensionFor(uri, 'image'));
    const probed = await ImageManipulator.manipulateAsync(
      localUri,
      [],
      { compress: 0.88, format: ImageManipulator.SaveFormat.JPEG },
    );
    if (probed.width > maxWidth) {
      const resized = await ImageManipulator.manipulateAsync(
        probed.uri,
        [{ resize: { width: maxWidth } }],
        { compress: 0.86, format: ImageManipulator.SaveFormat.JPEG },
      );
      return { uri: resized.uri, width: resized.width, height: resized.height };
    }
    return { uri: probed.uri, width: probed.width, height: probed.height };
  } catch {
    const fallbackUri = await ensureUploadableLocalUri(uri, extensionFor(uri, 'image'));
    return { uri: fallbackUri, width: null, height: null };
  }
}

/**
 * Upload one local file to the private bucket, reporting bytes as they leave the device.
 */
async function putObject(
  storagePath: string,
  fileUri: string,
  contentType: string,
  onProgress?: (progress: UploadProgress) => void,
  preloaded?: Blob | null,
): Promise<void> {
  const { url, key, token } = await requireUploadEnv();
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
  const endpoint = `${url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    apikey: key,
    'x-upsert': 'true',
    'Content-Type': contentType,
  };

  if (Platform.OS === 'web') {
    const { status, body } = await putObjectViaXhr(endpoint, headers, fileUri, onProgress, preloaded);
    if (status < 200 || status >= 300) {
      throw new MediaPipelineError('upload', `The upload was refused by storage (HTTP ${status}). ${body}`);
    }
    return;
  }

  const ext = storagePath.split('.').pop() || 'bin';
  const localFileUri = await ensureUploadableLocalUri(fileUri, ext);

  const task = FileSystem.createUploadTask(
    endpoint,
    localFileUri,
    { httpMethod: 'POST', uploadType: FileSystemUploadType.BINARY_CONTENT, headers },
    (p) => {
      if (p.totalBytesExpectedToSend > 0) {
        onProgress?.({ sent: p.totalBytesSent, total: p.totalBytesExpectedToSend });
      }
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
        xhr.onload = () =>
          resolve({
            status: xhr.status,
            body: typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, 200) : '',
          });
        xhr.onerror = () => reject(new MediaPipelineError('upload', 'The upload connection failed.'));
        xhr.onabort = () => reject(new MediaPipelineError('upload', 'The upload was cancelled.'));
        xhr.send(blob);
      } catch (e) {
        reject(
          e instanceof MediaPipelineError
            ? e
            : new MediaPipelineError('upload', `The upload did not complete. ${(e as Error).message}`),
        );
      }
    })();
  });
}

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
  const { userId, kind, unique, onProgress } = opts;
  await requireUploadEnv();

  let workingUri = opts.uri;
  let width: number | null = null;
  let height: number | null = null;

  if (kind === 'image') {
    const prepared = await prepareLocalImage(opts.uri, 1600);
    workingUri = prepared.uri;
    width = prepared.width;
    height = prepared.height;
  } else {
    workingUri = await ensureUploadableLocalUri(opts.uri, extensionFor(opts.uri, 'video'));
  }

  const path = kind === 'image' ? `u/${userId}/${unique}.jpg` : assetPath(userId, kind, workingUri, unique);
  const local = opts.byteSize ? { size: opts.byteSize, blob: null } : await localBytes(workingUri);

  const { data, error } = await supabase!.rpc('begin_media_upload', {
    p_storage_path: path,
    p_kind: kind,
    p_byte_size: local.size ?? null,
    p_content_type: CONTENT_TYPE[kind],
  });
  const uploadId = data as string | null;
  if (error || !uploadId) {
    throw new MediaPipelineError(
      'begin',
      `The server would not reserve the upload path. ${error?.message ?? 'no id returned'}`,
    );
  }

  try {
    await putObject(path, workingUri, CONTENT_TYPE[kind], onProgress, local.blob);
  } catch (e) {
    throw e instanceof MediaPipelineError
      ? e
      : new MediaPipelineError('upload', `The upload did not complete. ${(e as Error).message}`);
  }

  return { uploadId, storagePath: path, kind, width, height };
}

/** Upload a video's poster frame as its own object; its path is recorded on the video's row. */
export async function uploadPoster(opts: { userId: string; posterUri: string; unique: string }): Promise<string> {
  const { userId, posterUri, unique } = opts;
  await requireUploadEnv();
  const prepared = await prepareLocalImage(posterUri, 1080);
  const path = `u/${userId}/${unique}-poster.jpg`;
  const local = await localBytes(prepared.uri);
  const { data, error } = await supabase!.rpc('begin_media_upload', {
    p_storage_path: path,
    p_kind: 'image',
    p_byte_size: local.size ?? null,
    p_content_type: 'image/jpeg',
  });
  const posterUploadId = data as string | null;
  if (error || !posterUploadId) {
    throw new MediaPipelineError(
      'begin',
      `The server would not reserve the poster path. ${error?.message ?? 'no id returned'}`,
    );
  }
  await putObject(path, prepared.uri, 'image/jpeg', undefined, local.blob);
  const { error: completeError } = await supabase!.rpc('complete_media_upload', {
    p_upload_id: posterUploadId,
    p_post_id: null,
    p_position: null,
    p_width: prepared.width,
    p_height: prepared.height,
    p_duration_ms: null,
    p_poster_path: null,
  });
  if (completeError) {
    throw new MediaPipelineError('complete', `The poster was uploaded but not registered. ${completeError.message}`);
  }
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
  await requireUploadEnv();
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
    throw new MediaPipelineError(
      'verify',
      `The server did not attach ${missing.length} of ${expected.length} file(s) to the post, so it is not saved.`,
    );
  }
}

/**
 * Best-effort removal of objects uploaded for a post that then failed.
 */
export async function discardAssets(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await supabase?.storage.from(MEDIA_BUCKET).remove(paths);
  } catch {
    // Collected by retention queue if unreachable.
  }
}

// ── Reading media back ─────────────────────────────────────────────────────────────────────────

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
    list.push({
      kind: row.kind,
      storagePath: row.storage_path,
      posterPath: row.poster_path,
      position: row.position,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
    });
    byPost.set(row.post_id, list);
  }
  for (const list of byPost.values()) list.sort((a, b) => a.position - b.position);
  return byPost;
}

/** 7-day TTL so persisted local cache never goes blank between background sessions. */
const SIGNED_TTL_SECONDS = 60 * 60 * 24 * 7;
const SIGN_FAILURE_COOLDOWN_MS = 15_000;
const signedCache = new Map<string, { url: string; expiresAt: number }>();
const recentSignFailures = new Map<string, number>();

export type SignedUrlBatchRow = {
  path: string | null;
  signedUrl?: string | null;
  signedURL?: string | null;
};

export function resetMediaSignCacheForTests(): void {
  signedCache.clear();
  recentSignFailures.clear();
}

/**
 * Extracts the bucket-internal object path (`u/<uid>/...`) from an existing signed or relative URL
 * so expired URLs from older sessions can always be re-signed on demand.
 */
export function extractStoragePathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  if (/^(u|avatars|catalog)\//.test(url)) return url;
  const m = /\/object\/(?:sign|public|authenticated)\/media\/([^?#]+)/.exec(url);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Pure, testable signed-URL resolver with 1 bounded automatic retry on transient failure and zero
 * public-URL fallback for private media paths.
 */
export async function resolveSignedUrlsWithSigner(
  paths: string[],
  signer: (wanted: string[]) => Promise<{ data: SignedUrlBatchRow[] | null; error: { message: string } | null }>,
  retryDelayMs = 200,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const now = Date.now();
  const wanted: string[] = [];
  for (const rawPath of paths) {
    const path = extractStoragePathFromUrl(rawPath) ?? rawPath;
    if (!path) continue;
    const hit = signedCache.get(path);
    if (hit && hit.expiresAt > now) out.set(rawPath, hit.url);
    else wanted.push(path);
  }
  if (!wanted.length) return out;

  const uniqueWanted = [...new Set(wanted)];
  let attempt = await signer(uniqueWanted);
  if (attempt.error) {
    if (retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    attempt = await signer(uniqueWanted);
  }
  if (attempt.error) {
    throw new MediaPipelineError('verify', `Media could not be signed for display. ${attempt.error.message}`);
  }

  const byPath = new Map<string, string>();
  for (const row of attempt.data ?? []) {
    const fullUrl = normalizeMediaUrl(row.signedUrl ?? row.signedURL ?? null);
    if (!row.path || !fullUrl) continue;
    signedCache.set(row.path, { url: fullUrl, expiresAt: now + (SIGNED_TTL_SECONDS - 300) * 1000 });
    recentSignFailures.delete(row.path);
    byPath.set(row.path, fullUrl);
  }
  for (const rawPath of paths) {
    const path = extractStoragePathFromUrl(rawPath) ?? rawPath;
    const resolved = byPath.get(path) ?? signedCache.get(path)?.url;
    if (resolved) out.set(rawPath, resolved);
  }
  return out;
}

/**
 * Storage paths → full HTTPS signed URLs.
 */
export async function signedUrls(paths: string[]): Promise<Map<string, string>> {
  if (!paths.length || !supabase) return new Map();
  return resolveSignedUrlsWithSigner(paths, (wanted) =>
    supabase!.storage.from(MEDIA_BUCKET).createSignedUrls(wanted, SIGNED_TTL_SECONDS),
  );
}

/**
 * Invalidates cache and mints a fresh HTTPS signed URL for an expired or transiently failed storage
 * path. Enforces a 15s per-path cooldown (unless `force === true`) so broken/unauthorized media
 * never triggers infinite retry loops.
 */
export async function refreshSignedUrl(
  pathOrUrl?: string | null,
  force = false,
): Promise<string | null> {
  const path = extractStoragePathFromUrl(pathOrUrl);
  if (!path || !supabase) return null;
  const now = Date.now();
  const lastFail = recentSignFailures.get(path) ?? 0;
  if (!force && now - lastFail < SIGN_FAILURE_COOLDOWN_MS) {
    return null;
  }
  signedCache.delete(path);
  try {
    const map = await signedUrls([path]);
    const resolved = map.get(path) ?? null;
    if (!resolved) {
      recentSignFailures.set(path, Date.now());
    }
    return resolved;
  } catch {
    recentSignFailures.set(path, Date.now());
    return null;
  }
}

/** Upload a member's profile avatar into their own private `u/<uid>/…` folder and sign it. */
export async function uploadAvatar(userId: string, fileUri: string): Promise<{ storagePath: string; signedUrl: string }> {
  await requireUploadEnv();
  const prepared = await prepareLocalImage(fileUri, 640);
  const storagePath = `u/${userId}/avatar-${Date.now()}.jpg`;
  const local = await localBytes(prepared.uri);
  await putObject(storagePath, prepared.uri, 'image/jpeg', undefined, local.blob);
  signedCache.delete(storagePath);
  const signed = await signedUrls([storagePath]);
  const signedUrl = signed.get(storagePath);
  if (!signedUrl) {
    throw new MediaPipelineError('verify', 'Uploaded avatar could not be signed for display.');
  }
  return { storagePath, signedUrl };
}
