/**
 * Server bootstrap (migration 20 `get_bootstrap()` + migration 40 `get_client_sync_state()`) —
 * one cold-start round trip for the member's profile, preferences, follows, saves, reactions,
 * collections, communities, blocks/mutes, alerts, watchlist and notification inbox.
 */
import type { ReactionKind, User } from '../model';
import { supabase } from './client';

export interface BootstrapProfile {
  id: string;
  handle: string;
  display_name: string;
  avatar_path: string | null;
  bio: string | null;
  worlds: string[];
  favorite_genres: string[];
  favorite_title_ids?: string[];
  verified: boolean;
  is_private: boolean;
  follower_count: number;
  following_count: number;
  onboarding_completed: boolean;
  onboarding_step: number;
  onboarding_genres?: string[];
  account_status: string;
  created_at: string;
}

export interface ServerCollectionBundle {
  collection: {
    id: string;
    owner_id: string;
    title: string;
    description: string | null;
    visibility: 'public' | 'private';
    follower_count: number;
    created_at: string;
    updated_at: string;
  };
  owner?: {
    id: string;
    handle: string;
    display_name: string;
    avatar_path: string | null;
    verified: boolean;
    worlds: string[] | null;
  };
  items: {
    collection_id: string;
    title_id: string;
    position: number;
    note: string | null;
    added_at: string;
  }[];
}

export interface BootstrapPayload {
  profile: BootstrapProfile;
  prefs: Record<string, unknown> | null;
  unread_count: number;
  follows: { users: string[]; titles: string[]; people: string[]; collections: string[] };
  saved_post_ids: string[];
  watchlist: unknown[];
  communities?: string[];
  reactions?: { post_id: string | null; comment_id: string | null; kind: ReactionKind }[];
  collections?: ServerCollectionBundle[];
  blocks?: string[];
  muted_users?: string[];
  muted_titles?: string[];
  alerts?: { title_id: string; episodes: boolean; trending?: boolean }[];
  notifications?: unknown[];
}

interface SyncStateRaw {
  me: BootstrapProfile;
  preferences: Record<string, unknown> | null;
  unread_notifications: number;
  follows: BootstrapPayload['follows'];
  saved_post_ids: string[];
  watchlist: unknown[];
  communities?: string[];
  reactions?: BootstrapPayload['reactions'];
  collections?: ServerCollectionBundle[];
  blocks?: string[];
  muted_users?: string[];
  muted_titles?: string[];
  alerts?: BootstrapPayload['alerts'];
  notifications?: unknown[];
}

/**
 * Fetches `get_client_sync_state()` (falling back to `get_bootstrap()`) for the signed-in member.
 */
export async function fetchBootstrap(): Promise<BootstrapPayload> {
  if (!supabase) throw new Error('No backend configured — cannot fetch bootstrap.');
  const syncRes = await supabase.rpc('get_client_sync_state');
  if (!syncRes.error && syncRes.data) {
    const raw = syncRes.data as SyncStateRaw;
    return {
      profile: raw.me,
      prefs: raw.preferences,
      unread_count: raw.unread_notifications ?? 0,
      follows: raw.follows ?? { users: [], titles: [], people: [], collections: [] },
      saved_post_ids: raw.saved_post_ids ?? [],
      watchlist: raw.watchlist ?? [],
      communities: raw.communities ?? [],
      reactions: raw.reactions ?? [],
      collections: raw.collections ?? [],
      blocks: raw.blocks ?? [],
      muted_users: raw.muted_users ?? [],
      muted_titles: raw.muted_titles ?? [],
      alerts: raw.alerts ?? [],
      notifications: raw.notifications ?? [],
    };
  }
  const { data, error } = await supabase.rpc('get_bootstrap');
  if (error) throw error;
  if (!data) throw new Error('get_bootstrap returned no payload.');
  return data as BootstrapPayload;
}

/** Maps the server profile row onto the client `User` shape (partial patch). */
export function serverProfileToUser(
  p: BootstrapProfile,
  resolved?: { avatarUrl?: string; favoriteDramaIds?: string[] },
): Partial<User> & Pick<User, 'id'> {
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.display_name,
    avatarUrl: resolved?.avatarUrl,
    bio: p.bio ?? undefined,
    fandoms: (p.worlds ?? []) as User['fandoms'],
    favoriteGenres: p.favorite_genres ?? [],
    favoriteDramaIds: resolved?.favoriteDramaIds ?? [],
    followers: p.follower_count ?? 0,
    following: p.following_count ?? 0,
    verified: p.verified,
    isPrivate: p.is_private,
    joinedAt: p.created_at,
  };
}
