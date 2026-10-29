/**
 * Offline Subtitles Helper for Hallyu TV Downloads.
 * Automatically fetches and stores subtitle files alongside downloaded video files,
 * enabling seamless offline playback with subtitles.
 */
import * as FileSystem from 'expo-file-system';
import { fetchCaptionCues, fetchMovieboxCaptions, fetchOpenSubtitleCues, searchOpenSubtitles } from './api/subtitles';
import type { WatchEpisodeRef } from './watchStore';
import type { SubtitleCue } from './subtitles';

export interface SavedSubtitleData {
  label: string;
  language: string;
  cues: SubtitleCue[];
}

export function subtitleFileUriFor(videoFileUri: string): string {
  return `${videoFileUri}.subtitles.json`;
}

/**
 * Downloads and saves subtitles locally alongside a downloaded video file.
 * Non-blocking: errors are caught so video downloads never fail or crash due to subtitles.
 */
export async function saveSubtitleForDownload(ref: WatchEpisodeRef, videoFileUri: string): Promise<boolean> {
  if (!videoFileUri || videoFileUri.startsWith('http') || !FileSystem.documentDirectory) return false;
  const subUri = subtitleFileUriFor(videoFileUri);
  try {
    // 1. Try MovieBox Captions upstream
    const r = await fetchMovieboxCaptions({
      subjectId: ref.subjectId,
      season: ref.season ?? undefined,
      episode: ref.episode ?? undefined,
    });
    if (r.ok && Array.isArray(r.value) && r.value.length > 0) {
      const preferred = r.value.find((c) => /^en/i.test(c.language)) ?? r.value[0];
      if (preferred) {
        const got = await fetchCaptionCues(preferred.url);
        if (got.ok && got.value.cues.length > 0) {
          const payload: SavedSubtitleData = {
            label: preferred.label,
            language: preferred.language,
            cues: got.value.cues,
          };
          await FileSystem.writeAsStringAsync(subUri, JSON.stringify(payload));
          return true;
        }
      }
    }

    // 2. Fallback to OpenSubtitles online search if MovieBox had no captions
    if (ref.title) {
      const osRes = await searchOpenSubtitles({
        query: ref.title,
        season: ref.season ?? undefined,
        episode: ref.episode ?? undefined,
        language: 'en',
      });
      if (osRes.ok && Array.isArray(osRes.value) && osRes.value.length > 0) {
        const best = osRes.value[0];
        const got = await fetchOpenSubtitleCues(best.fileId);
        if (got.ok && got.value.cues.length > 0) {
          const payload: SavedSubtitleData = {
            label: best.release || best.language || 'English',
            language: best.language || 'en',
            cues: got.value.cues,
          };
          await FileSystem.writeAsStringAsync(subUri, JSON.stringify(payload));
          return true;
        }
      }
    }
  } catch {
    // Non-blocking: video download is primary and must complete reliably.
  }
  return false;
}

/**
 * Reads local offline subtitles saved alongside a video file.
 */
export async function readLocalSubtitle(videoFileUri: string): Promise<SavedSubtitleData | null> {
  if (!videoFileUri || videoFileUri.startsWith('http') || !FileSystem.documentDirectory) return null;
  const subUri = subtitleFileUriFor(videoFileUri);
  try {
    const info = await FileSystem.getInfoAsync(subUri).catch(() => null);
    if (!info || !info.exists) return null;
    const content = await FileSystem.readAsStringAsync(subUri);
    const parsed = JSON.parse(content) as SavedSubtitleData;
    if (parsed && Array.isArray(parsed.cues) && parsed.cues.length > 0) {
      return parsed;
    }
  } catch {
    // Return null if unreadable or corrupted
  }
  return null;
}

export async function deleteLocalSubtitle(videoFileUri: string): Promise<void> {
  if (!videoFileUri || videoFileUri.startsWith('http') || !FileSystem.documentDirectory) return;
  const subUri = subtitleFileUriFor(videoFileUri);
  await FileSystem.deleteAsync(subUri, { idempotent: true }).catch(() => {});
}
