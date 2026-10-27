import { Redirect } from 'expo-router';
import React from 'react';

export default function NotificationsRedirect() {
  return <Redirect href="/(tabs)/activity" />;
}
