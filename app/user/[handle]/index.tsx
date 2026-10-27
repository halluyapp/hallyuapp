import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ProfileView } from '../../../components/profile/ProfileView';
import { Screen } from '../../../components/ui/Screen';
import { ListSkeleton } from '../../../components/ui/Skeleton';
import { ErrorState } from '../../../components/ui/States';
import { TopBar } from '../../../components/ui/TopBar';
import { supabase } from '../../../lib/api/client';
import { useApp } from '../../../lib/hooks';
import { getState } from '../../../lib/store';
import { adoptLocal, adoptProfileByHandle } from '../../../lib/sync';

/** Public profile by handle (also the /u/{handle} deep link). Your own handle redirects to the You tab experience. */
export default function UserProfile() {
  const router = useRouter();
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const { getUserByHandle, me } = useApp();
  const clean = (handle ?? '').replace(/^@/, '');
  const isMe = clean.toLowerCase() === me.handle.toLowerCase();
  const user = isMe ? me : getUserByHandle(clean);
  const [hydrating, setHydrating] = useState<boolean>(() => Boolean(!user && supabase && clean));

  useEffect(() => {
    if (!clean || !supabase) return;
    let alive = true;
    if (!user) setHydrating(true);
    void adoptProfileByHandle(clean, {
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
      addPosts: (posts) => {
        for (const p of posts) adoptLocal({ type: 'addPost', post: p });
      },
    }).finally(() => {
      if (alive) setHydrating(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean]);

  if (!user && hydrating) {
    return (
      <Screen header={<TopBar mode="stack" title={clean ? `@${clean}` : 'Profile'} />}>
        <ListSkeleton rows={4} />
      </Screen>
    );
  }

  if (!user) {
    return (
      <Screen header={<TopBar mode="stack" title="Profile" />}>
        <ErrorState kind="notFound" title={`@${clean} isn’t here`} body="The account may have been deleted or the handle changed." onRetry={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} />
      </Screen>
    );
  }
  return (
    <Screen header={<TopBar mode="stack" title={`@${user.handle}`} />}>
      <ProfileView user={user} isMe={user.id === me.id} />
    </Screen>
  );
}
