import type { Drama, Episode, Notification, WatchlistItem } from './model';

export const EPISODE_NOTIFIED_STORAGE_KEY = 'hallyu.episode_notified.v1';

export interface AiredEpisodeCandidate {
  key: string;
  drama: Drama;
  episode: Episode;
  airMs: number;
  notification: Notification;
  toastTitle: string;
  deepLink: string;
}

export interface EpisodeEvaluationState {
  prefs: { notifications: { episodes: boolean } & Record<string, boolean> };
  follows: { dramas: string[] };
  dramaNotify: Record<string, boolean>;
  importedDramas: Drama[];
  watchlist: Record<string, WatchlistItem>;
  notifications: Notification[];
}

const DEFAULT_WINDOW_HOURS = 48;
const LIVE_WINDOW_MS = 3 * 3600_000;

/**
 * Pure evaluator: finds recently aired episodes for dramas the user follows (with episode alerts enabled)
 * that haven't already been watched or notified. Works identically across Web and Native so users
 * receive in-app inbox items, toast alerts, browser notifications, and native OS banners.
 */
export function evaluateAiredEpisodeNotifications(input: {
  state: EpisodeEvaluationState;
  nowMs?: number;
  alreadyNotifiedKeys: ReadonlySet<string>;
  windowHours?: number;
}): AiredEpisodeCandidate[] {
  const { state, alreadyNotifiedKeys } = input;
  if (state.prefs.notifications.episodes === false) return [];

  const nowMs = input.nowMs ?? Date.now();
  const windowMs = (input.windowHours ?? DEFAULT_WINDOW_HOURS) * 3600_000;
  const minMs = nowMs - windowMs;

  // Dramas where notifications are explicitly on or followed without explicit opt-out
  const eligibleIds = new Set<string>(state.follows.dramas);
  for (const [dramaId, on] of Object.entries(state.dramaNotify)) {
    if (on === true) eligibleIds.add(dramaId);
  }

  const out: AiredEpisodeCandidate[] = [];

  for (const drama of state.importedDramas) {
    if (!eligibleIds.has(drama.id)) continue;
    if (state.dramaNotify[drama.id] === false) continue;
    if (drama.mediaType === 'movie') continue;

    const watch = state.watchlist[drama.id];
    const multiSeason = drama.seasons.length > 1;
    const candidates: Episode[] = [...drama.episodes];

    // Fallback: if a drama has `nextEpisodeAt` in the recent air window and no matching episode row,
    // synthesize the expected next episode entry so thin catalog records still alert the user.
    if (!candidates.some((e) => e.airDate) && drama.nextEpisodeAt) {
      const nextNum = Math.max(1, (watch?.currentEpisode ?? 0) + 1);
      const nextSeason = Math.max(1, watch?.season ?? drama.seasons.at(-1)?.number ?? 1);
      candidates.push({
        id: `${drama.id}-s${nextSeason}e${nextNum}`,
        dramaId: drama.id,
        season: nextSeason,
        number: nextNum,
        airDate: drama.nextEpisodeAt,
      });
    }

    for (const ep of candidates) {
      if (!ep.airDate) continue;
      const airMs = Date.parse(ep.airDate);
      if (!Number.isFinite(airMs)) continue;
      if (airMs > nowMs || airMs < minMs) continue;

      // Skip episodes the user has already watched
      if (
        watch &&
        (watch.season > ep.season || (watch.season === ep.season && watch.currentEpisode >= ep.number))
      ) {
        continue;
      }

      const key = `ep-aired:${drama.id}:${ep.season}:${ep.number}`;
      if (alreadyNotifiedKeys.has(key)) continue;

      const existsInInbox = state.notifications.some(
        (n) =>
          n.id === key ||
          (n.dramaId === drama.id &&
            n.episode === ep.number &&
            (n.kind === 'episode_aired' || n.kind === 'episode_live')),
      );
      if (existsInInbox) continue;

      const isLive = nowMs - airMs <= LIVE_WINDOW_MS;
      const epTag = multiSeason ? `S${ep.season} E${ep.number}` : `Episode ${ep.number}`;
      const deepLink = `/episode/${drama.id}/${ep.season}/${ep.number}`;
      const title = `${drama.title} · ${epTag} ${isLive ? 'is live now' : 'just aired'}`;
      const body = ep.title
        ? `“${ep.title}” is out — join the spoiler-safe episode room.`
        : 'New episode is out — tap to open the episode room.';

      out.push({
        key,
        drama,
        episode: ep,
        airMs,
        deepLink,
        toastTitle: `${drama.title} · ${epTag} aired`,
        notification: {
          id: key,
          group: 'drama',
          kind: isLive ? 'episode_live' : 'episode_aired',
          dramaId: drama.id,
          episode: ep.number,
          title,
          body,
          deepLink,
          createdAt: new Date(airMs).toISOString(),
          read: false,
        },
      });
    }
  }

  return out.sort((a, b) => b.airMs - a.airMs);
}

/** Merge newly detected episode-aired notifications ahead of existing notifications without duplicating IDs. */
export function mergeEpisodeNotifications(
  existing: Notification[],
  incoming: Notification[],
): Notification[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((n) => n.id));
  const additions = incoming.filter((n) => !seen.has(n.id));
  if (!additions.length) return existing;
  return [...additions, ...existing].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
