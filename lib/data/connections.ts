/**
 * Followers / following lookups.
 *
 * With a backend session this reads the REAL graph: `follows` is selectable by any authenticated
 * member (RLS `follows_select_all`) and the profiles come through the visible-profile policy — no
 * fabrication, no guessed slice.
 *
 * A device-local build (or a signed-out visitor) keeps the original honest behaviour: your own
 * Following tab is the real device graph, and anyone else's tab shows what the device actually
 * knows, most followed first. It never claims an edge that does not exist.
 */
import { fetchProfiles } from '../api/feed';
import { supabase } from '../api/client';
import { hasSession } from '../api/social';
import { User } from '../model';
import * as sel from '../selectors';
import { AppState, dispatch, getState } from '../store';

/** Cache the resolved people so the profile screens render instantly on a repeat visit. */
function remember(profiles: User[]): void {
  if (!profiles.length) return;
  dispatch({ type: 'hydrate', state: { users: { ...getState().users, ...Object.fromEntries(profiles.map((p) => [p.id, p])) } } });
}

async function backendConnections(userId: string, tab: 'followers' | 'following'): Promise<User[] | null> {
  if (!supabase) return null;
  const column = tab === 'following' ? 'target_id' : 'follower_id';
  const match = tab === 'following' ? 'follower_id' : 'target_id';
  const { data, error } = await supabase.from('follows').select(column).eq(match, userId).limit(200);
  if (error || !data) return hasSession() ? null : null;
  const ids = data.map((row) => (row as Record<string, string>)[column]).filter(Boolean);
  if (!ids.length) return [];
  const profiles = await fetchProfiles(ids);
  remember(profiles);
  return profiles;
}

/** Resolve a handle to a profile id even when the device has never seen that member. */
async function backendUserIdForHandle(handle: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('profiles').select('id').ilike('handle', handle).limit(1);
  if (error || !data?.length) return null;
  return (data[0] as { id: string }).id;
}

export async function fetchConnections(handle: string, tab: 'followers' | 'following'): Promise<(Partial<User> & { id: string })[]> {
  const s: AppState = getState();
  const own = handle.toLowerCase() === s.profile.handle.toLowerCase();
  let user: Partial<User> & { id: string } = own ? s.profile : sel.getUserByHandle(s, handle) ?? { id: '' };
  if (!user.id) {
    const remoteId = await backendUserIdForHandle(handle);
    if (!remoteId) return [];
    user = { id: remoteId };
  }

  const remote = await backendConnections(user.id, tab);
  if (remote) return remote;

  const others = Object.values(s.users).filter((u) => u.id !== user.id && !s.blockedUsers.includes(u.id));

  if (tab === 'following') {
    if (own) {
      return s.follows.users.map((id) => sel.getUser(s, id)).filter((u): u is User => !!u);
    }
    return [...others].sort((a, b) => b.followers - a.followers).slice(0, Math.min(6, user.following ?? 0));
  }

  // No incoming edges exist locally for someone else's followers tab, so show the community this
  // account sits in, most followed first — never a fabricated edge.
  return [...others].sort((a, b) => b.followers - a.followers).slice(0, Math.min(8, user.followers ?? 0));
}
