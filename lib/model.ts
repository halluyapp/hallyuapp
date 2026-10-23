/**
 * Hallyu content model — see docs/design/02-content-model-and-rules.md
 */
export type ID = string;

/**
 * The entertainment worlds Hallyu unifies. One app, one community, four fandoms — never four apps.
 * A member can belong to one, several or all of them (see the "What are you into?" onboarding step).
 */
export type FandomId = 'kdrama' | 'cdrama' | 'anime' | 'hollywood';

/** Which TMDB endpoint a record came from. */
export type MediaType = 'tv' | 'movie';

/** How a title actually is — used for labels, rails and section layout (a film has no episodes). */
export type Format = 'kdrama' | 'cdrama' | 'anime' | 'hollywood-series' | 'hollywood-movie';

export type SpoilerLevel = 'none' | 'episode' | 'season' | 'ending';
export type SpoilerProtection = 'strict' | 'balanced' | 'off';
export type WatchStatus = 'want' | 'watching' | 'completed' | 'dropped';
export type DramaStatus = 'upcoming' | 'airing' | 'completed' | 'canceled';
export type PostType = 'post' | 'reaction' | 'discussion' | 'review' | 'recommendation' | 'short';
export type DiscussionKind = 'general' | 'theory' | 'ending' | 'character' | 'scene' | 'question';
export type ReactionKind = 'loved' | 'cried' | 'screamed' | 'swooned' | 'laughed' | 'furious';
export type NotificationGroup = 'social' | 'drama' | 'mentions' | 'system';
export type Visibility = 'public' | 'private';

export const REACTIONS: { kind: ReactionKind; label: string; glyph: string }[] = [
  { kind: 'loved', label: 'Loved', glyph: '♥' },
  { kind: 'cried', label: 'Cried', glyph: '💧' },
  { kind: 'screamed', label: 'Screamed', glyph: '⚡' },
  { kind: 'swooned', label: 'Swooned', glyph: '✿' },
  { kind: 'laughed', label: 'Laughed', glyph: '☺' },
  { kind: 'furious', label: 'Furious', glyph: '✖' },
];

export type ReactionCounts = Record<ReactionKind, number>;
export const emptyReactions = (): ReactionCounts => ({ loved: 0, cried: 0, screamed: 0, swooned: 0, laughed: 0, furious: 0 });

export type VerificationTier = 'none' | 'blue' | 'red';
export type BadgeCategory = 'executive' | 'early_member' | 'participation' | 'content' | 'community';
export type BadgeRarity = 'standard' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface BadgeDefinition {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  iconKey: string;
  accentHex: string;
  maxSupply?: number | null;
  isNumbered: boolean;
  isAutomatic: boolean;
  thresholdKind?: string | null;
  thresholdValue?: number | null;
  sortOrder: number;
  claimedCount?: number;
}

export interface UserAward {
  awardId: string;
  badgeId: string;
  serialNumber?: number | null;
  source: string;
  awardNote?: string | null;
  awardedAt: string;
  name: string;
  subtitle: string;
  description: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  iconKey: string;
  accentHex: string;
  maxSupply?: number | null;
  isNumbered: boolean;
}

/**
 * Resolves the authoritative 2-tier verification seal for any user summary:
 * - `'red'` -> Executive / Official Hallyu Authority (@ceohallyu & designated official accounts)
 * - `'blue'` -> Authentic Verified Identity (verified creators, journalists, community leaders, figures)
 * - `'none'` -> Unverified member
 */
export function resolveVerificationTier(
  subject?: { verified?: boolean; verificationTier?: VerificationTier | string | null } | null,
): VerificationTier {
  if (!subject) return 'none';
  if (subject.verificationTier === 'red') return 'red';
  if (subject.verificationTier === 'blue') return 'blue';
  if (subject.verificationTier === 'none') return 'none';
  return subject.verified ? 'blue' : 'none';
}

export interface User {
  id: ID;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  avatarPath?: string;
  /** Optional custom drama/banner backdrop URL displayed on the member's profile hero. */
  bannerUrl?: string;
  bio?: string;
  /** The worlds this member belongs to, shown on their profile as "Anime · K-Drama · Hollywood". */
  fandoms?: FandomId[];
  favoriteGenres: string[];
  favoriteDramaIds: ID[];
  followers: number;
  following: number;
  joinedAt: string;
  verified?: boolean;
  verificationTier?: VerificationTier;
  verificationNote?: string;
  verifiedAt?: string;
  isFounder?: boolean;
  excludeFromCompetitions?: boolean;
  featuredBadgeIds?: string[];
  awards?: UserAward[];
  isPrivate?: boolean;
  role?: 'member' | 'moderator' | 'admin';
}

export interface Episode {
  id: ID;
  dramaId: ID;
  season: number;
  number: number;
  title?: string;
  airDate?: string; // ISO
  runtime?: number; // minutes
  synopsis?: string;
  stillUrl?: string;
}

export interface Season {
  number: number;
  name?: string;
  year?: number;
  episodeCount: number;
}

export interface CastCredit {
  actorId: ID;
  role: string;
  order: number;
}

export interface Drama {
  id: ID; // slug
  title: string;
  originalTitle?: string;
  /** Film or series — a film hub has no episodes. Records from the catalog always carry this. */
  mediaType?: MediaType;
  /** Which world this title belongs to (K-Drama, C-Drama, Anime, Hollywood). */
  format?: Format;
  originalLanguage?: string;
  region?: string;
  /** Feature-film runtime in minutes (series carry per-episode runtimes instead). */
  runtime?: number;
  year: number;
  endYear?: number;
  status: DramaStatus;
  network?: string;
  streamingOn?: string[];
  genres: string[];
  tags?: string[];
  synopsis: string;
  posterUrl?: string;
  posterLocal?: number; // require()
  backdropUrl?: string;
  /** Official YouTube trailer or teaser URL when available from TMDB or local seed. */
  trailerUrl?: string;
  tone: string; // fallback poster colour
  rating?: number; // community 1–10
  episodeCount: number;
  seasons: Season[];
  episodes: Episode[];
  cast: CastCredit[];
  /** Optional hydrated cast actor records returned alongside a detailed catalog fetch. */
  castActors?: Actor[];
  creators?: string[];
  airsOn?: string; // e.g. "Sat–Sun 21:20 KST"
  nextEpisodeAt?: string; // ISO
  followerCount: number;
  provider?: { name: 'tmdb'; id: number; mediaType?: MediaType };
}

export interface Actor {
  id: ID;
  name: string;
  koreanName?: string;
  photoUrl?: string;
  birthDate?: string;
  bio?: string;
  knownFor: ID[];
  /** Optional hydrated filmography drama records returned alongside a catalog fetch. */
  knownForDramas?: Drama[];
  followerCount: number;
  provider?: { name: 'tmdb'; id: number };
}

export interface PostContext {
  dramaId?: ID;
  season?: number;
  episode?: number; // episode number within season
  actorIds?: ID[];
  secondaryDramaId?: ID; // "if you liked …" for recommendations
  /** When set, the post belongs to a fandom community as well as (optionally) a title. */
  communityId?: ID;
}

/**
 * A fandom space. Communities are the social half of a world: a K-Drama room, an anime room, a
 * movie-night room. The feed lives on the community page (Popular | Latest | Media).
 */
export interface Community {
  id: ID;
  name: string;
  /** The world this community sits in — drives the chip and the default rail it appears on. */
  fandom: FandomId;
  description: string;
  coverTone: string;
  coverUrl?: string;
  /** Optional anchor title for universe-specific rooms (One Piece, Marvel…). */
  dramaId?: ID;
  memberCount: number;
  postCount: number;
  isOfficial?: boolean;
  createdAt: string;
}

export interface PostPoll {
  question: string;
  options: string[];
  counts: number[];
  totalVotes: number;
  myVote?: number | null;
  closesAt?: string | null;
}

export interface DirectMessage {
  id: ID;
  senderId: ID;
  recipientId: ID;
  body: string;
  sharedDramaId?: ID;
  sharedPostId?: ID;
  readAt?: string | null;
  createdAt: string;
}

export interface ConversationSummary {
  peerId: ID;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  verified?: boolean;
  verificationTier?: VerificationTier;
  lastMessageId: ID;
  lastSenderId: ID;
  lastBody: string;
  sharedDramaId?: ID;
  sharedPostId?: ID;
  lastAt: string;
  unreadCount: number;
}

export interface Post {
  id: ID;
  type: PostType;
  authorId: ID;
  createdAt: string;
  editedAt?: string;
  body: string;
  title?: string; // discussion
  kind?: DiscussionKind; // discussion
  rating?: number; // review 1–10
  verdict?: string; // review one-liner
  poll?: PostPoll;
  images?: (string | number)[];
  imagePaths?: string[];
  video?: {
    url: string;
    key?: string;
    storagePath?: string;
    posterPath?: string;
    poster?: string | number;
    duration: number;
    width?: number;
    height?: number;
  };
  spoiler: SpoilerLevel;
  context: PostContext;
  hashtags: string[];
  mentions: ID[];
  reactions: ReactionCounts;
  commentCount: number;
  saveCount: number;
  shareCount: number;
  /** deleted = removed by its author; hidden = moderated. Absent means active. */
  state?: 'active' | 'deleted' | 'hidden';
}

export interface Comment {
  id: ID;
  postId: ID;
  authorId: ID;
  parentId?: ID; // one level of threading
  replyToUserId?: ID;
  body: string;
  createdAt: string;
  spoiler: SpoilerLevel;
  reactions: ReactionCounts;
  /** deleted = removed by its author; hidden = moderated. Absent means active. */
  state?: 'active' | 'deleted' | 'hidden';
}

export interface WatchlistItem {
  dramaId: ID;
  status: WatchStatus;
  season: number;
  currentEpisode: number; // last watched episode number (0 = none)
  note?: string;
  addedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CollectionItem {
  dramaId: ID;
  note?: string;
  addedAt: string;
}

export interface Collection {
  id: ID;
  ownerId: ID;
  title: string;
  description?: string;
  visibility: Visibility;
  items: CollectionItem[];
  followerCount: number;
  updatedAt: string;
}

export interface Notification {
  id: ID;
  group: NotificationGroup;
  /** Notifications can point at a community too ("a community you follow is trending"). */
  communityId?: ID;
  kind: 'reaction' | 'comment' | 'reply' | 'follow' | 'mention' | 'episode_aired' | 'episode_live' | 'drama_trending' | 'collection_saved' | 'system';
  actorIds?: ID[];
  postId?: ID;
  commentId?: ID;
  dramaId?: ID;
  episode?: number;
  collectionId?: ID;
  title?: string;
  body?: string;
  deepLink?: string;
  createdAt: string;
  read: boolean;
}

export interface Draft {
  id: ID;
  type: PostType;
  updatedAt: string;
  title?: string;
  body: string;
  rating?: number;
  verdict?: string;
  kind?: DiscussionKind;
  spoiler: SpoilerLevel;
  context: PostContext;
  images: string[];
}

export const LIMITS = {
  post: 1000,
  reaction: 140,
  discussionTitle: 90,
  discussionBody: 5000,
  reviewVerdict: 120,
  reviewBody: 5000,
  recommendation: 500,
  shortCaption: 300,
  comment: 1000,
  images: 6,
  /** seconds — shorts are 3–60 s, a post can carry a clip up to 2:20 like X */
  shortVideo: 60,
  postVideo: 140,
  actors: 3,
  bio: 160,
  displayName: 40,
  collectionTitle: 60,
  collectionDescription: 240,
  note: 200,
  editWindowMs: 15 * 60 * 1000,
} as const;

export const GENRES = [
  'Romance',
  'Thriller',
  'Fantasy',
  'Comedy',
  'Melodrama',
  'Crime',
  'Historical',
  'Slice of life',
  'Mystery',
  'Action',
  'Medical',
  'Legal',
  'Youth',
  'Family',
  'Horror',
  'Sci-fi',
] as const;

export type Genre = (typeof GENRES)[number];
