import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://kzxlbscfkixnswurpkzb.supabase.co';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

console.log('=== Testing Anonymous Sign In & Moviebox Edge Function ===');

const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function main() {
  console.log('[1] Attempting signInAnonymously()...');
  const anonRes = await client.auth.signInAnonymously();
  if (anonRes.error) {
    console.log('signInAnonymously error:', anonRes.error.message);
  } else {
    console.log('signInAnonymously success! User ID:', anonRes.data.user?.id);
    console.log('Access token acquired:', Boolean(anonRes.data.session?.access_token));
  }

  const token = anonRes.data?.session?.access_token;
  if (!token) {
    console.log('[2] Trying signUp fallback...');
    const signUpRes = await client.auth.signUp({
      email: `guest.${Date.now()}@example.invalid`,
      password: `Guest!${Date.now()}#Pass`
    });
    console.log('signUp result:', signUpRes.data?.session ? 'Session obtained' : signUpRes.error?.message);
  }
}

main().catch(console.error);
