import { FANDOM_IDS, formatFandomOf, isValidWorldDrama } from './fandoms';
import type { Drama, FandomId, Post, WatchlistItem } from './model';

export type BillboardCategory = 'all' | FandomId;

export interface BillboardEntry {
  rank: number;
  drama: Drama;
  world: FandomId;
  score: number;
  watchersCount: number;
  isLiveAiring: boolean;
}

export interface ComputeBillboardInput {
  trending?: Drama[] | null;
  airing?: Drama[] | null;
  popular?: Drama[] | null;
  byWorld?: Partial<Record<FandomId, Drama[] | null>>;
  posts?: Post[];
  watchlist?: Record<string, WatchlistItem>;
  category: BillboardCategory;
  limit?: number;
  nowMs?: number;
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * Pure Top 10 Billboard ranker: merges live TMDB trending/popular/airing catalogs with Hallyu
 * community viewership signals (active watchers + recent 7-day discussion momentum) so the
 * billboard always reflects the top dramas people are actively watching right now.
 */
export function computeTopBillboard(input: ComputeBillboardInput): BillboardEntry[] {
  const limit = input.limit ?? 10;
  const nowMs = input.nowMs ?? Date.now();
  const postCutoff = nowMs - SEVEN_DAYS_MS;

  // Build rank index maps from TMDB lists
  const trendingRank = new Map<string, number>();
  const popularRank = new Map<string, number>();
  const airingSet = new Set<string>();
  const worldTrendingRank = new Map<string, number>();
  const catalogById = new Map<string, Drama>();

  const register = (list: Drama[] | null | undefined) => {
    if (!list) return;
    for (const d of list) {
      if (!d?.id || !isValidWorldDrama(d)) continue;
      if (!catalogById.has(d.id)) catalogById.set(d.id, d);
    }
  };

  register(input.trending);
  register(input.airing);
  register(input.popular);
  if (input.byWorld) {
    for (const fid of FANDOM_IDS) {
      const list = input.byWorld[fid];
      register(list);
      list?.forEach((d, idx) => {
        if (d?.id && !worldTrendingRank.has(d.id)) worldTrendingRank.set(d.id, idx);
      });
    }
  }

  input.trending?.forEach((d, idx) => {
    if (d?.id && !trendingRank.has(d.id)) trendingRank.set(d.id, idx);
  });
  input.popular?.forEach((d, idx) => {
    if (d?.id && !popularRank.has(d.id)) popularRank.set(d.id, idx);
  });
  input.airing?.forEach((d) => {
    if (d?.id) airingSet.add(d.id);
  });

  // Aggregate real community signals
  const recentPostsByDrama = new Map<string, number>();
  for (const p of input.posts ?? []) {
    if (p.state === 'deleted' || !p.context.dramaId) continue;
    const ts = Date.parse(p.createdAt);
    if (Number.isFinite(ts) && ts >= postCutoff) {
      recentPostsByDrama.set(p.context.dramaId, (recentPostsByDrama.get(p.context.dramaId) ?? 0) + 1);
    }
  }

  const activeWatchersByDrama = new Map<string, number>();
  for (const item of Object.values(input.watchlist ?? {})) {
    if (item.status === 'watching' || item.status === 'want') {
      activeWatchersByDrama.set(item.dramaId, (activeWatchersByDrama.get(item.dramaId) ?? 0) + 1);
    }
  }

  const scored: Omit<BillboardEntry, 'rank'>[] = [];
  for (const drama of catalogById.values()) {
    const world = formatFandomOf(drama);
    if (input.category !== 'all' && world !== input.category) continue;

    const tIdx = trendingRank.get(drama.id);
    const wIdx = worldTrendingRank.get(drama.id);
    const pIdx = popularRank.get(drama.id);
    const isLiveAiring = drama.status === 'airing' || airingSet.has(drama.id);

    let score = 0;
    if (tIdx !== undefined) score += Math.max(20, 140 - tIdx * 4);
    if (wIdx !== undefined) score += Math.max(15, 110 - wIdx * 3.5);
    if (pIdx !== undefined) score += Math.max(10, 70 - pIdx * 2);
    if (isLiveAiring) score += 36;
    if (drama.rating) score += drama.rating * 4.5;
    score += Math.log10(Math.max(10, drama.followerCount || 10)) * 16;
    score += (recentPostsByDrama.get(drama.id) ?? 0) * 14;
    score += (activeWatchersByDrama.get(drama.id) ?? 0) * 18;

    const watchersCount =
      Math.max(0, drama.followerCount || 0) +
      (activeWatchersByDrama.get(drama.id) ?? 0) * 25 +
      (recentPostsByDrama.get(drama.id) ?? 0) * 40;

    scored.push({
      drama,
      world,
      score,
      watchersCount,
      isLiveAiring,
    });
  }

  scored.sort((a, b) => b.score - a.score || (b.drama.rating ?? 0) - (a.drama.rating ?? 0));

  // For 'all', ensure the top 10 features the #1 title from every represented world first, then fills by highest score
  if (input.category === 'all' && scored.length > limit) {
    const pickedIds = new Set<string>();
    const podium: Omit<BillboardEntry, 'rank'>[] = [];
    for (const fid of FANDOM_IDS) {
      const topInWorld = scored.find((e) => e.world === fid && !pickedIds.has(e.drama.id));
      if (topInWorld) {
        pickedIds.add(topInWorld.drama.id);
        podium.push(topInWorld);
      }
    }
    const rest = scored.filter((e) => !pickedIds.has(e.drama.id));
    const combined = [...podium.sort((a, b) => b.score - a.score), ...rest].slice(0, limit);
    return combined.map((entry, idx) => ({ ...entry, rank: idx + 1 }));
  }

  return scored.slice(0, limit).map((entry, idx) => ({ ...entry, rank: idx + 1 }));
}

export function formatBillboardUpdatedAt(updatedAtMs: number | null, nowMs = Date.now()): string {
  if (!updatedAtMs) return 'Live catalog syncing…';
  const diffSec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (diffSec < 15) return 'Updated just now';
  if (diffSec < 60) return `Updated ${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Updated ${diffMin}m ago`;
  return `Updated ${Math.floor(diffMin / 60)}h ago`;
}
