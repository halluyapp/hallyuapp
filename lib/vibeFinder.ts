/**
 * Hallyu Vibe Finder — the query reader and the ranking layer.
 *
 * Pure TypeScript with no React Native or network imports, so it can be tested directly.
 *
 * Honesty rules this file follows:
 *  - Only the rules-based reader is wired in. No AI model is called. The `interpreter` field says so.
 *  - A filter is applied only when the member asked for it. Unknown metadata never passes a requested
 *    filter (a title with no rating does not satisfy "highly rated").
 *  - Every reason shown to a member is built from a field that actually matched, never from generic copy.
 */
import type { Drama, FandomId } from './model';

export type VibeStatus = 'airing' | 'upcoming' | 'completed';
export type VibeMediaType = 'tv' | 'movie';

export interface VibeQuery {
  raw: string;
  world: FandomId | null;
  mediaType: VibeMediaType | null;
  status: VibeStatus | null;
  genres: string[];
  avoidGenres: string[];
  minRating: number | null;
  maxEpisodes: number | null;
  moods: string[];
  avoidMoods: string[];
  excludeCompleted: boolean;
  /** How the query was read. Only 'rules' is implemented. */
  interpreter: 'rules';
  /** Number of structured signals found. Zero means the reader could not turn the text into filters. */
  signalCount: number;
}

/** Seam for a future model-backed reader. It must return the same shape, validated, or null to fall back. */
export type VibeQueryInterpreter = (raw: string) => Promise<VibeQuery | null> | VibeQuery | null;

const GENRE_KEYWORDS: [RegExp, string][] = [
  [/\b(romance|romantic|love stor\w*|slow[- ]?burn romance|love triangle)\b/, 'Romance'],
  [/\b(thriller|thrillers|suspense|suspenseful|psychological)\b/, 'Thriller'],
  [/\b(fantasy|magic|magical|mythic\w*|supernatural)\b/, 'Fantasy'],
  [/\b(comedy|comedies|funny|hilarious|laugh\w*|sitcom)\b/, 'Comedy'],
  [/\b(melodrama|melodramatic|tearjerker)\b/, 'Melodrama'],
  [/\b(crime|detective|police|cop|cops|heist)\b/, 'Crime'],
  [/\b(historical|period|joseon|dynasty|ancient|kingdom|palace)\b/, 'Historical'],
  [/\b(mystery|mysteries|whodunit|whodunnit|keeps me guessing|puzzle)\b/, 'Mystery'],
  [/\b(action|battles?|fights?|fighting)\b/, 'Action'],
  [/\b(medical|hospital|doctors?|surgeons?)\b/, 'Medical'],
  [/\b(legal|lawyers?|courtroom|law firm)\b/, 'Legal'],
  [/\b(school|youth|coming[- ]of[- ]age|teen\w*)\b/, 'Youth'],
  [/\b(family|families|kids|parents)\b/, 'Family'],
  [/\b(horror|scary|creepy|ghosts?|haunted)\b/, 'Horror'],
  [/\b(sci[- ]?fi|science fiction|futuristic|space|alien\w*)\b/, 'Sci-fi'],
  [/\b(slice of life|slice-of-life|everyday life)\b/, 'Slice of life'],
];

/** Mood words are soft: they raise a title whose own synopsis or tags use the same idea. */
const MOOD_KEYWORDS: [RegExp, string, string[]][] = [
  [/\bdark\b|\bgrim\b|\bbleak\b|\bnoir\b/, 'dark', ['dark', 'grim', 'bleak', 'noir']],
  [/\bpolitic\w*|\bintrigue\b|\bconspir\w*|\bscheming\b|\bcourt\b/, 'political intrigue', ['political', 'intrigue', 'conspir', 'scheme', 'court', 'power']],
  [/\brevenge\b|\bvengeance\b|\bavenge\b/, 'revenge', ['revenge', 'vengeance', 'avenge']],
  [/\bslow[- ]?burn\b/, 'slow-burn', ['slow', 'quiet', 'gradual']],
  [/\bcomfort\w*|\bcozy\b|\bwarm\b|\bheartwarming\b|\bfeel[- ]good\b|\bhealing\b/, 'comforting', ['heartwarm', 'cozy', 'cosy', 'gentle', 'warm', 'healing', 'feel-good']],
  [/\bfemale lead\b|\bstrong (female|woman|heroine)\b|\bpowerful (female|woman|heroine)\b/, 'strong female lead', ['woman', 'heroine', 'her ', 'she ', 'female']],
  [/\bclever\b|\bsmart\b|\bstrategic\b/, 'clever', ['clever', 'strategy', 'strategic', 'plan', 'brilliant']],
];

const AVOID_MOOD_KEYWORDS: [RegExp, string, string[]][] = [
  [/\bless tragic\b|\bnot tragic\b|\bno tragedy\b|\bless sad\b|\bhappier\b|\blighter\b/, 'tragic', ['tragic', 'tragedy', 'grief', 'dies', 'death', 'sad']],
];

const WORLD_RULES: [RegExp, FandomId][] = [
  [/\b(k-?drama|korean|korea|k drama)\b/, 'kdrama'],
  [/\b(c-?drama|chinese|china|mainland)\b/, 'cdrama'],
  [/\b(anime|japanese|japan)\b/, 'anime'],
  [/\b(hollywood|american|us series|english-language)\b/, 'hollywood'],
];

function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Deterministic reader. Every rule maps a phrase to a field the catalogue actually stores. */
export function parseVibeQuery(raw: string): VibeQuery {
  const text = normalize(raw);
  const query: VibeQuery = {
    raw: raw.trim(),
    world: null,
    mediaType: null,
    status: null,
    genres: [],
    avoidGenres: [],
    minRating: null,
    maxEpisodes: null,
    moods: [],
    avoidMoods: [],
    excludeCompleted: false,
    interpreter: 'rules',
    signalCount: 0,
  };
  if (!text) return query;

  const worlds = WORLD_RULES.filter(([re]) => re.test(text)).map(([, w]) => w);
  if (new Set(worlds).size === 1) query.world = worlds[0]!;

  const isMovie = /\b(movies?|films?)\b/.test(text);
  const isSeries = /\b(series|shows?|dramas? series|tv)\b/.test(text);
  if (isMovie && !isSeries) query.mediaType = 'movie';
  else if (isSeries && !isMovie) query.mediaType = 'tv';

  if (/\b(completed|finished|complete|ended|full season)\b/.test(text)) query.status = 'completed';
  else if (/\b(airing|ongoing|currently airing|on going|still airing)\b/.test(text)) query.status = 'airing';
  else if (/\bupcoming\b/.test(text)) query.status = 'upcoming';

  if (/\b(avoid|skip|not)\b[^.]*\b(already|completed|finished|watched|seen)\b|\bhaven'?t (seen|watched)\b|\bnew to me\b/.test(text)) {
    query.excludeCompleted = true;
  }

  for (const [re, genre] of GENRE_KEYWORDS) {
    if (!re.test(text)) continue;
    // "little romance", "no romance" and similar ask for the genre to be avoided.
    const negated = new RegExp(`\\b(little|less|no|without|minimal|not much)\\s+(\\w+\\s+)?${genre.toLowerCase().split(' ')[0]}`).test(text);
    if (negated) query.avoidGenres.push(genre);
    else query.genres.push(genre);
  }
  query.genres = [...new Set(query.genres)];
  query.avoidGenres = [...new Set(query.avoidGenres)].filter((g) => !query.genres.includes(g));

  if (/\b(highly rated|acclaimed|best rated|top rated|masterpiece|must[- ]watch)\b/.test(text)) query.minRating = 7.5;
  if (/\b(8\+|above 8|over 8)\b/.test(text)) query.minRating = 8;

  if (/\b(short (series|show|drama|anime)|mini[- ]?series|limited series|short\b|few episodes)\b/.test(text)) {
    query.maxEpisodes = 16;
  }
  const epCap = /\b(\d{1,3})\s*episodes?\s*(or less|or fewer|max|maximum|at most)\b/.exec(text);
  if (epCap) query.maxEpisodes = Math.min(200, Number(epCap[1]));

  for (const [re, label] of MOOD_KEYWORDS) if (re.test(text)) query.moods.push(label);
  for (const [re, label] of AVOID_MOOD_KEYWORDS) if (re.test(text)) query.avoidMoods.push(label);

  query.signalCount =
    (query.world ? 1 : 0) +
    (query.mediaType ? 1 : 0) +
    (query.status ? 1 : 0) +
    query.genres.length +
    query.avoidGenres.length +
    (query.minRating !== null ? 1 : 0) +
    (query.maxEpisodes !== null ? 1 : 0) +
    query.moods.length +
    query.avoidMoods.length +
    (query.excludeCompleted ? 1 : 0);
  return query;
}

/** Maps a catalogue record to its fandom world. Returns null when the format is unknown. */
export function worldOf(drama: Pick<Drama, 'format'>): FandomId | null {
  switch (drama.format) {
    case 'kdrama':
      return 'kdrama';
    case 'cdrama':
      return 'cdrama';
    case 'anime':
      return 'anime';
    case 'hollywood-series':
    case 'hollywood-movie':
      return 'hollywood';
    default:
      return null;
  }
}

const WORLD_LABEL: Record<FandomId, string> = {
  kdrama: 'K-Drama',
  cdrama: 'C-Drama',
  anime: 'Anime',
  hollywood: 'Hollywood',
};

export interface VibeContext {
  /** Titles the member muted or chose "Not interested" for. Always excluded. */
  mutedDramaIds?: readonly string[];
  /** Titles the member has marked completed. Excluded when the query asks to avoid completed titles. */
  completedDramaIds?: readonly string[];
  /** The member's chosen worlds from onboarding. Empty or missing means all worlds. */
  favouriteWorlds?: readonly FandomId[];
}

export interface VibeResult {
  drama: Drama;
  score: number;
  /** Reasons built only from fields that matched. */
  reasons: string[];
}

export interface VibeRanking {
  query: VibeQuery;
  results: VibeResult[];
  /** Plain-language note explaining what the reader did. Shown to the member. */
  note: string;
}

const MAX_RESULTS = 12;

function lower(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((v) => v.toLowerCase());
}

function haystack(d: Drama): string {
  return `${d.synopsis ?? ''} ${(d.tags ?? []).join(' ')}`.toLowerCase();
}

/**
 * Applies hard filters (only the ones the member asked for), then ranks with soft signals, and builds
 * the explanation for each result from the fields that matched.
 */
export function rankVibeResults(candidates: readonly Drama[], query: VibeQuery, ctx: VibeContext = {}): VibeRanking {
  const muted = new Set(ctx.mutedDramaIds ?? []);
  const completed = new Set(ctx.completedDramaIds ?? []);
  const favourite = new Set(ctx.favouriteWorlds ?? []);
  const wantGenres = query.genres.map((g) => g.toLowerCase());
  const avoidGenres = query.avoidGenres.map((g) => g.toLowerCase());
  const seen = new Set<string>();
  const scored: VibeResult[] = [];

  for (const d of candidates) {
    if (!d || !d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    if (muted.has(d.id)) continue;
    if (query.excludeCompleted && (d.status === 'completed' || completed.has(d.id))) continue;

    const genres = lower(d.genres);

    if (query.world && worldOf(d) !== query.world) continue;
    if (query.mediaType && d.mediaType !== query.mediaType) continue;
    if (query.status && d.status !== query.status) continue;
    if (wantGenres.length && !wantGenres.some((g) => genres.includes(g))) continue;
    if (avoidGenres.some((g) => genres.includes(g))) continue;
    if (query.minRating !== null && (typeof d.rating !== 'number' || d.rating < query.minRating)) continue;
    if (query.maxEpisodes !== null) {
      // A short-series request needs a known episode count and a series, never a film.
      if (d.mediaType === 'movie' || !(d.episodeCount > 0) || d.episodeCount > query.maxEpisodes) continue;
    }

    let score = 0;
    const reasons: string[] = [];

    const matchedGenres = (d.genres ?? []).filter((g) => wantGenres.includes(g.toLowerCase()));
    if (matchedGenres.length) {
      score += 3 * matchedGenres.length;
      reasons.push(`${matchedGenres.join(' and ')} ${matchedGenres.length === 1 ? 'title' : 'titles'} you asked for`);
    }

    const text = haystack(d);
    for (const mood of query.moods) {
      const words = MOOD_KEYWORDS.find(([, label]) => label === mood)?.[2] ?? [];
      const hit = words.find((w) => text.includes(w));
      if (hit) {
        score += 1.5;
        reasons.push(`Synopsis or tags point to ${mood}`);
      }
    }
    for (const mood of query.avoidMoods) {
      const words = AVOID_MOOD_KEYWORDS.find(([, label]) => label === mood)?.[2] ?? [];
      if (words.some((w) => text.includes(w))) score -= 2;
    }

    if (query.status && d.status === query.status) {
      reasons.push(`${query.status === 'completed' ? 'Completed' : query.status === 'airing' ? 'Currently airing' : 'Upcoming'} ${d.mediaType === 'movie' ? 'film' : 'series'}`);
    }
    if (query.world && worldOf(d) === query.world) reasons.push(`${WORLD_LABEL[query.world]} title`);
    if (query.minRating !== null && typeof d.rating === 'number') reasons.push(`Rated ${d.rating.toFixed(1)}`);
    if (query.maxEpisodes !== null && d.episodeCount > 0) reasons.push(`${d.episodeCount} episodes`);
    if (typeof d.rating === 'number') score += (d.rating / 10) * 2;
    const world = worldOf(d);
    if (favourite.size && world) score += favourite.has(world) ? 0.5 : -0.5;

    scored.push({ drama: d, score, reasons: reasons.slice(0, 3) });
  }

  scored.sort((a, b) => b.score - a.score || (b.drama.rating ?? 0) - (a.drama.rating ?? 0) || a.drama.title.localeCompare(b.drama.title));
  const results = scored.slice(0, MAX_RESULTS);

  const note =
    query.signalCount === 0
      ? 'We could not turn that into filters, so these match your words.'
      : 'Read with rules on this device. No AI model is connected, so this is a filter-based reading of your words.';
  return { query, results, note };
}

/** Human-readable summary of what the reader understood. Shown so the member can check it. */
export function describeVibeQuery(query: VibeQuery): string[] {
  const parts: string[] = [];
  if (query.world) parts.push(WORLD_LABEL[query.world]);
  if (query.mediaType) parts.push(query.mediaType === 'movie' ? 'Movies' : 'Series');
  if (query.status) parts.push(query.status === 'completed' ? 'Completed' : query.status === 'airing' ? 'Airing' : 'Upcoming');
  for (const g of query.genres) parts.push(g);
  if (query.minRating !== null) parts.push(`Rated ${query.minRating}+`);
  if (query.maxEpisodes !== null) parts.push(`Up to ${query.maxEpisodes} episodes`);
  for (const g of query.avoidGenres) parts.push(`Less ${g}`);
  for (const m of query.moods) parts.push(m);
  for (const m of query.avoidMoods) parts.push(`Less ${m}`);
  if (query.excludeCompleted) parts.push('Not completed');
  return parts;
}
