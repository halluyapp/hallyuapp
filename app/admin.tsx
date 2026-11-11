import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { TopBar } from '../components/ui/TopBar';
import { useApp } from '../lib/hooks';
import { hasModeratorAccess } from '../lib/roles';

export default function AdminPlatformScreen() {
  const params = useLocalSearchParams<{ section?: string; tab?: string }>();
  const { me } = useApp();

  // Direct deep links receive the same presentation gate as Settings. This is not authorization:
  // every staff RPC and RLS policy independently re-derives the member's role on the server.
  if (!hasModeratorAccess(me.role)) {
    return (
      <Screen header={<TopBar mode="stack" title="Hallyu Admin Console" />}>
        <EmptyState
          icon="lock-closed-outline"
          title="Staff access required"
          body="This console is limited to Hallyu moderators, administrators and the CEO."
        />
      </Screen>
    );
  }

  return (
    <AdminDashboard
      initialSection="overview"
      routeParam={params.section ?? params.tab}
      title="Hallyu Admin Console"
    />
  );
}
