import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthCallback } from './authCallbackParse';

test('parseAuthCallback identifies Rork Google OAuth PKCE code callback URLs', () => {
  const parsed = parseAuthCallback('rork-app://auth/callback?code=pkce_abc_123');
  assert.deepEqual(parsed, {
    kind: 'session',
    code: 'pkce_abc_123',
    recovery: false,
    isRorkScheme: true,
  });
});

test('parseAuthCallback identifies web OAuth code callbacks and Supabase email recovery fragments', () => {
  const webCode = parseAuthCallback('https://hallyu.app/auth/callback?code=email_verify_code');
  assert.equal(webCode?.kind, 'session');
  assert.equal(webCode?.code, 'email_verify_code');
  assert.equal(webCode?.isRorkScheme, false);

  const recovery = parseAuthCallback(
    'hallyu://auth/callback#access_token=jwt_tok&refresh_token=ref_tok&type=recovery',
  );
  assert.deepEqual(recovery, {
    kind: 'session',
    accessToken: 'jwt_tok',
    refreshToken: 'ref_tok',
    recovery: true,
    isRorkScheme: false,
  });
});

test('parseAuthCallback returns structured unsupported error on OAuth errors or missing tokens', () => {
  const denied = parseAuthCallback('rork-app://auth/callback?error=access_denied&error_description=User+cancelled');
  assert.equal(denied?.kind, 'unsupported');
  assert.equal(denied?.error, 'access_denied');
  assert.equal(denied?.errorDescription, 'User cancelled');
  assert.equal(denied?.isRorkScheme, true);

  const empty = parseAuthCallback('hallyu://auth/callback');
  assert.equal(empty?.kind, 'unsupported');
  assert.equal(empty?.error, 'no_tokens');

  assert.equal(parseAuthCallback('not-a-url'), null);
});
