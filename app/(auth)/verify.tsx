import { Redirect } from 'expo-router';
import React from 'react';
import { useAuth } from '../../lib/auth';

/** Compatibility for old bookmarks. New accounts do not need a confirmation email. */
export default function Verify() {
  const auth = useAuth();
  if (auth.status === 'loading') return null;
  return <Redirect href={auth.status === 'signedIn' ? '/' : '/(auth)/sign-in'} />;
}
