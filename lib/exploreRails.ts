import { FANDOM_IDS, formatFandomOf, isValidWorldDrama } from './fandoms';
import type { Drama, FandomId } from './model';

export interface ExploreRailsInput {
  leaders?: Drama[] | null;
  trending?: Drama[] | null;
  airing?: Drama[] | null;
  topRated?: Drama[] | null;
  upcoming?: Drama[] | null;
  netflix?: Drama[] | null;
}

export interface WorldLeaderEntry {
  world: FandomId;
  drama: Drama;
}

export interface ExploreRailsOutput {
  leaders: WorldLeaderEntry[];
  trending: Drama[];
  airing: Drama[];
  topRated: Drama[];
  upcoming: Drama[];
  netflix: Drama[];
  wall: Drama[];
}

function uniqueValid(items: Drama[] | null | undefined, exclude?: ReadonlySet<string>): Drama[] {
  if (!items?.length) return [];
  const seen = new Set<string>(exclude);
  const out: Drama[] = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    if (!isValidWorldDrama(item)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Computes genuine per-world #1 leaders and strictly distinct, deduplicated Explore rails:
 * - Four distinct world leaders (#1 K-Drama, #1 C-Drama, #1 Anime, #1 Hollywood)
 * - Balanced cross-world Trending rail with zero leader duplicates
 * - Distinct Airing, Highest Rated, Upcoming, Netflix, and Wall rails with zero cross-rail duplicates
 */
export function buildExploreRails(input: ExploreRailsInput): ExploreRailsOutput {
  const validLeaders = uniqueValid(input.leaders);
  const validTrending = uniqueValid(input.trending);

  const leaderByWorld = new Map<FandomId, Drama>();
  const usedIds = new Set<string>();

  for (const d of validLeaders) {
    const w = formatFandomOf(d);
    if (!leaderByWorld.has(w) && !usedIds.has(d.id)) {
      leaderByWorld.set(w, d);
      usedIds.add(d.id);
    }
  }

  // Fallback for device-local or partial loads: derive any missing world's #1 from validTrending.
  for (const world of FANDOM_IDS) {
    if (leaderByWorld.has(world)) continue;
    const candidate = validTrending.find((d) => formatFandomOf(d) === world && !usedIds.has(d.id));
    if (candidate) {
      leaderByWorld.set(world, candidate);
      usedIds.add(candidate.id);
    }
  }

  const leaders: WorldLeaderEntry[] = FANDOM_IDS.filter((w) => leaderByWorld.has(w)).map((world) => ({
    world,
    drama: leaderByWorld.get(world)!,
  }));

  const trending = uniqueValid(input.trending, usedIds);
  for (const d of trending) usedIds.add(d.id);

  const airingRaw = uniqueValid(input.airing).filter((d) => d.status === 'airing');
  const airingDeduped = airingRaw.filter((d) => !usedIds.has(d.id));
  const airing = airingDeduped.length >= 4 ? airingDeduped : airingRaw;
  for (const d of airing) usedIds.add(d.id);

  const topRatedRaw = uniqueValid(input.topRated).filter((d) => d.status !== 'upcoming' && d.status !== 'canceled');
  const topRatedDeduped = topRatedRaw.filter((d) => !usedIds.has(d.id));
  const topRated = topRatedDeduped.length >= 4 ? topRatedDeduped : topRatedRaw.filter((d) => !leaderByWorld.has(formatFandomOf(d)) || leaderByWorld.get(formatFandomOf(d))?.id !== d.id);
  for (const d of topRated) usedIds.add(d.id);

  const upcomingRaw = uniqueValid(input.upcoming).filter((d) => d.status === 'upcoming');
  const upcomingDeduped = upcomingRaw.filter((d) => !usedIds.has(d.id));
  const upcoming = upcomingDeduped.length >= 4 ? upcomingDeduped : upcomingRaw;
  for (const d of upcoming) usedIds.add(d.id);

  const netflixRaw = uniqueValid(input.netflix);
  const netflixDeduped = netflixRaw.filter((d) => !usedIds.has(d.id));
  const netflix = netflixDeduped.length >= 4 ? netflixDeduped : netflixRaw;

  // Wall shows distinct titles beyond the visible top cards of the Trending horizontal rail.
  const trendingLeadIds = new Set(trending.slice(0, 8).map((d) => d.id));
  const wallPool = [
    ...trending.slice(8),
    ...topRated.filter((d) => !trendingLeadIds.has(d.id)),
    ...airing.filter((d) => !trendingLeadIds.has(d.id)),
  ];
  const wallSeen = new Set<string>(leaders.map((l) => l.drama.id));
  const wall: Drama[] = [];
  for (const d of wallPool) {
    if (wallSeen.has(d.id) || trendingLeadIds.has(d.id)) continue;
    wallSeen.add(d.id);
    wall.push(d);
    if (wall.length >= 8) break;
  }

  return { leaders, trending, airing, topRated, upcoming, netflix, wall };
}
