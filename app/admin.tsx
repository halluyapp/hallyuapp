import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { AdminDashboard } from '../components/admin/AdminDashboard';

export default function AdminPlatformScreen() {
  const params = useLocalSearchParams<{ section?: string; tab?: string }>();
  return (
    <AdminDashboard
      initialSection="overview"
      routeParam={params.section ?? params.tab}
      title="Hallyu Admin Console"
    />
  );
}
