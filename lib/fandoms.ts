/**
 * The four Hallyu worlds.
 *
 * Hallyu is one community where four fandom worlds meet — K-Dramas, C-Dramas, Anime and Hollywood.
 * They are not four apps: a member belongs to one, several or all of them, the default experience is
 * ALL, and every list in the product can be narrowed to a single world when that is what you want.
 *
 * This file is the single source of truth for that vocabulary:
 *   • the worlds themselves (label, flag, blurb, tint, TMDB query)
 *   • how a catalog record is assigned to a world (`inferFormat` / `dramaFormat`)
 *   • the short labels the UI prints on chips, cards and the Content Hub
 *
 * Tints come from the existing palette in constants/theme.ts — no new colours are introduced.
 */
import { Drama, FandomId, Format, MediaType } from './model';

/** One TMDB endpoint to read a world from. Hollywood is the only world that spans two. */
export interface FandomQuery {
  media: MediaType;
  params: Record<string, string>;
}

export interface Fandom {
  id: FandomId;
  /** Chip label, plural: "K-Dramas". */
  label: string;
  /** Card/context label, singular: "K-Drama". */
  short: string;
  flag: string;
  /** Where it comes from — used in onboarding copy. */
  home: string;
  tagline: string;
  blurb: string;
  /** Tint from constants/theme.ts's palette. */
  tint: string;
  formats: Format[];
  queries: FandomQuery[];
  /** Words a member would use about this world — search hints and empty states. */
  hints: string[];
}

const KR = { with_origin_country: 'KR', include_null_first_air_dates: 'false' };

export const FANDOMS: Fandom[] = [
  {
    id: 'kdrama',
    label: 'K-Dramas',
    short: 'K-Drama',
    flag: '🇰🇷',
    home: 'South Korea',
    tagline: 'Romance, revenge and the best-written families on television',
    blurb: 'Sixteen episodes, one soundtrack you will never escape, and a fandom that watches live at 2am.',
    tint: '#FB7185',
    formats: ['kdrama'],
    queries: [{ media: 'tv', params: KR }],
    hints: ['slow burn', 'second lead syndrome', 'sageuk', 'chaebol'],
  },
  {
    id: 'cdrama',
    label: 'C-Dramas',
    short: 'C-Drama',
    flag: '🇨🇳',
    home: 'China',
    tagline: 'Wuxia, xianxia and slow-burn romances with forty-episode patience',
    blurb: 'Historical epics, immortals, palace intrigue — and costume design that deserves its own fan account.',
    tint: '#F2B84B',
    formats: ['cdrama'],
    queries: [{ media: 'tv', params: { with_original_language: 'zh', include_null_first_air_dates: 'false' } }],
    hints: ['wuxia', 'xianxia', 'historical', 'palace intrigue'],
  },
  {
    id: 'anime',
    label: 'Anime',
    short: 'Anime',
    flag: '🇯🇵',
    home: 'Japan',
    tagline: 'Shōnen tournaments, slice-of-life comfort and everything in between',
    blurb: 'Seasonal simulcasts, decade-old classics and the best fight choreography in any medium.',
    tint: '#60A5FA',
    formats: ['anime'],
    queries: [{ media: 'tv', params: { with_genres: '16', with_original_language: 'ja', include_null_first_air_dates: 'false' } }],
    hints: ['shōnen', 'shoujo', 'isekai', 'slice of life'],
  },
  {
    id: 'hollywood',
    label: 'Hollywood',
    short: 'Hollywood',
    flag: '🇺🇸',
    home: 'United States',
    tagline: 'Films and prestige series the whole timeline argues about',
    blurb: 'The blockbuster, the awards-season slow burn, and the show everyone starts on the same weekend.',
    tint: '#34D399',
    formats: ['hollywood-series', 'hollywood-movie'],
    queries: [
      { media: 'movie', params: { with_original_language: 'en' } },
      { media: 'tv', params: { with_original_language: 'en', include_null_first_air_dates: 'false' } },
    ],
    hints: ['blockbuster', 'prestige tv', 'awards season', 'franchise'],
  },
];

export const FANDOM_IDS: FandomId[] = FANDOMS.map((f) => f.id);

const BY_ID = new Map<FandomId, Fandom>(FANDOMS.map((f) => [f.id, f]));

export function fandomById(id: FandomId): Fandom {
  return BY_ID.get(id) ?? FANDOMS[0]!;
}

export const isFandomId = (x: unknown): x is FandomId => typeof x === 'string' && BY_ID.has(x as FandomId);

/** Normalise an arbitrary list (imported profile JSON, deep links) into real world ids. */
export function toFandoms(ids: unknown): FandomId[] {
  if (!Array.isArray(ids)) return [];
  return FANDOM_IDS.filter((id) => ids.includes(id));
}

export function fandomsOf(ids: FandomId[]): Fandom[] {
  return ids.map(fandomById);
}

/** "Anime · K-Drama" — the one-line identity printed on profiles and posts. */
export function fandomLine(ids: FandomId[]): string {
  return ids.map((id) => fandomById(id).short).join(' · ');
}

// -----------------------------------------------------------------------------------------------
// Format inference
// -----------------------------------------------------------------------------------------------

const CHINESE_LANGUAGES = new Set(['zh', 'cn', 'yue', 'nan', 'bo', 'wuu']);
const CHINESE_COUNTRIES = new Set(['CN', 'TW', 'HK']);
const WESTERN_COUNTRIES = new Set(['US', 'GB', 'CA', 'AU', 'NZ', 'IE']);

/**
 * Authoritative world classification across all four Hallyu worlds.
 * Returns `null` when a title does not genuinely belong to any supported world:
 * - Japanese live-action productions (`ja` / `JP` without `Animation` genre) are rejected from `anime`
 *   and never dumped into `hollywood` unless co-produced in English / Western territories.
 * - Non-Western international titles (Tamil, Hindi, Spanish, French, Turkish, etc.) are rejected
 *   from `hollywood` rather than mislabelled as American/Western cinema.
 */
export function classifyWorldFormat(input: {
  media: MediaType;
  language?: string;
  countries?: string[];
  genres?: string[];
}): Format | null {
  const lang = (input.language ?? '').trim().toLowerCase();
  const countries = (input.countries ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const genres = input.genres ?? [];
  const hasCountry = (set: Set<string>) => countries.some((c) => set.has(c));
  const isAnimated = genres.some((g) => g.toLowerCase() === 'animation');

  if (lang === 'ko' || countries.includes('KR')) return 'kdrama';
  if (CHINESE_LANGUAGES.has(lang) || hasCountry(CHINESE_COUNTRIES)) return 'cdrama';

  if (lang === 'ja' || countries.includes('JP')) {
    if (isAnimated) return 'anime';
    if (lang === 'en' || hasCountry(WESTERN_COUNTRIES)) {
      return input.media === 'movie' ? 'hollywood-movie' : 'hollywood-series';
    }
    return null;
  }

  if (lang === 'en' || hasCountry(WESTERN_COUNTRIES)) {
    return input.media === 'movie' ? 'hollywood-movie' : 'hollywood-series';
  }

  if (isAnimated && !lang && countries.length === 0) return 'anime';
  return null;
}

/** True when a Drama record genuinely belongs to one of Hallyu's four worlds. */
export function isValidWorldDrama(d: Pick<Drama, 'mediaType' | 'format' | 'originalLanguage' | 'region' | 'genres'>): boolean {
  const countries = d.region ? [d.region] : undefined;
  if (d.originalLanguage || countries?.length) {
    const inferred = classifyWorldFormat({
      media: d.mediaType ?? 'tv',
      language: d.originalLanguage,
      countries,
      genres: d.genres,
    });
    if (!inferred) return false;
    if (d.format === 'anime' && !d.genres.some((g) => g.toLowerCase() === 'animation')) return false;
    return true;
  }
  if (d.format === 'anime' && d.genres.length > 0 && !d.genres.some((g) => g.toLowerCase() === 'animation')) {
    return false;
  }
  return Boolean(d.format);
}

/**
 * Fallback world format for records already accepted into the catalog.
 */
export function inferFormat(input: { media: MediaType; language?: string; countries?: string[]; genres?: string[] }): Format {
  return (
    classifyWorldFormat(input) ??
    (input.media === 'movie' ? 'hollywood-movie' : 'hollywood-series')
  );
}

/** A record's world, including local records that predate the format field. */
export function dramaFormat(d: Drama): Format {
  if (d.format) return d.format;
  return (
    classifyWorldFormat({
      media: d.mediaType ?? 'tv',
      language: d.originalLanguage,
      countries: d.region ? [d.region] : undefined,
      genres: d.genres,
    }) ?? (d.mediaType === 'movie' ? 'hollywood-movie' : 'hollywood-series')
  );
}

export function formatFandom(format: Format): FandomId {
  switch (format) {
    case 'kdrama':
      return 'kdrama';
    case 'cdrama':
      return 'cdrama';
    case 'anime':
      return 'anime';
    default:
      return 'hollywood';
  }
}

/** The world a record lives in. */
export function dramaFandom(d: Drama): Fandom {
  return fandomById(formatFandom(dramaFormat(d)));
}

export function formatFandomOf(d: Drama): FandomId {
  return formatFandom(dramaFormat(d));
}

/** True when the record belongs to one of the viewer's worlds (empty selection = everything). */
export function inWorlds(d: Drama, worlds: FandomId[]): boolean {
  return worlds.length === 0 || worlds.includes(formatFandomOf(d));
}

// -----------------------------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------------------------

const FORMAT_LABEL: Record<Format, string> = {
  kdrama: 'K-Drama',
  cdrama: 'C-Drama',
  anime: 'Anime',
  'hollywood-series': 'Series',
  'hollywood-movie': 'Film',
};

/** "K-Drama", "C-Drama", "Anime", "Series", "Film". */
export function formatLabel(format: Format): string {
  return FORMAT_LABEL[format];
}

export function dramaLabel(d: Drama): string {
  return formatLabel(dramaFormat(d));
}

/** A film has no episode list; a series does. Media type is the reliable signal — a Korean film
 * (runtime, no episodes) must not be treated as an episode-based drama. */
export const isFilm = (d: Drama): boolean => (d.mediaType ?? (dramaFormat(d) === 'hollywood-movie' ? 'movie' : 'tv')) === 'movie';

/** "2h 18m" / "68 min" — films and episodes each have a runtime. */
export function runtimeLabel(minutes?: number): string | undefined {
  if (!minutes) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m} min`;
}

/**
 * The context line a post carries, e.g. "Anime · Frieren: Beyond Journey's End" or
 * "K-Drama · Goblin · Episode 8". Tapping it opens the Content Hub.
 */
export function contentContext(d: Drama, episode?: number): string {
  const where = `${dramaLabel(d)} · ${d.title}`;
  return episode ? `${where} · Episode ${episode}` : where;
}
