#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function jwt(sub, expired = false) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub, email: `${sub}@example.test`, exp: Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600) })}.signature`;
}

function loadRork({ fetchImpl, delays = {}, browserResult = { type: 'cancel' } }) {
  const values = new Map();
  const writes = [];
  const secure = {
    async getItemAsync(key) {
      if (delays.read) await new Promise((resolve) => setTimeout(resolve, delays.read));
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      writes.push(['set', key, value]);
      if (delays.write) await new Promise((resolve) => setTimeout(resolve, delays.write));
      values.set(key, value);
    },
    async deleteItemAsync(key) {
      writes.push(['delete', key]);
      if (delays.write) await new Promise((resolve) => setTimeout(resolve, delays.write));
      values.delete(key);
    },
  };
  const filename = `${process.cwd()}/lib/rorkAuth.ts`;
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const mocks = {
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      CryptoEncoding: { HEX: 'hex' },
      async getRandomBytesAsync(size) { return Uint8Array.from({ length: size }, (_, i) => i + 1); },
      async digestStringAsync() { return '00'.repeat(32); },
    },
    'expo-secure-store': secure,
    'expo-web-browser': { async openAuthSessionAsync() { return browserResult; } },
    'react-native': { Platform: { OS: 'android' } },
  };
  const context = vm.createContext({
    console, Buffer, TextDecoder, Uint8Array, URL, Date, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    fetch: fetchImpl,
    process: { env: { EXPO_PUBLIC_RORK_APP_KEY: 'test-app', EXPO_PUBLIC_RORK_AUTH_URL: 'https://auth.example.test' } },
  });
  context.globalThis = context;
  new vm.Script(`(function(exports, require, module) { ${output}\n})`, { filename }).runInContext(context)(
    module.exports,
    (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import ${specifier}`);
    },
    module,
  );
  return { auth: module.exports, values, writes };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('Rork refresh is single-flight, subject-preserving, and rotates a supplied refresh token', async () => {
  let calls = 0;
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const { auth, values } = loadRork({ fetchImpl: async () => { calls += 1; return pending; } });
  const original = jwt('rork-subject', true);
  values.set('hallyu.rork.access_token', original);
  values.set('hallyu.rork.refresh_token', 'refresh-one');
  const first = auth.refreshAccessToken();
  const second = auth.refreshAccessToken();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  resolveFetch(response(200, { access_token: jwt('rork-subject'), refresh_token: 'refresh-two' }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(values.get('hallyu.rork.refresh_token'), 'refresh-two');
  assert.equal(values.get('hallyu.rork.access_token'), a.accessToken);
});

test('network/5xx refresh failures preserve credentials; authentication rejection clears them', async () => {
  for (const status of [500, 401]) {
    const { auth, values } = loadRork({ fetchImpl: async () => response(status, {}) });
    values.set('hallyu.rork.access_token', jwt('subject', true));
    values.set('hallyu.rork.refresh_token', 'refresh');
    assert.equal(await auth.refreshAccessToken(), null);
    assert.equal(values.has('hallyu.rork.refresh_token'), status !== 401);
  }
});

test('logout during an in-flight refresh cannot resurrect secure-store credentials', async () => {
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const { auth, values } = loadRork({ fetchImpl: async () => pending, delays: { write: 5 } });
  values.set('hallyu.rork.access_token', jwt('subject', true));
  values.set('hallyu.rork.refresh_token', 'refresh');
  const refreshing = auth.refreshAccessToken();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const logout = auth.clearStoredTokens();
  resolveFetch(response(200, { access_token: jwt('subject') }));
  assert.equal(await refreshing, null);
  await logout;
  assert.equal(values.has('hallyu.rork.access_token'), false);
  assert.equal(values.has('hallyu.rork.refresh_token'), false);
});

test("a fresh Google account cannot be overwritten by the previous account's refresh", async () => {
  let resolveOldRefresh;
  const oldRefresh = new Promise((resolve) => { resolveOldRefresh = resolve; });
  const { auth, values } = loadRork({
    browserResult: { type: 'success', url: 'rork-test://auth/callback?code=new-code' },
    fetchImpl: async (url) => {
      if (url.endsWith('/oauth/refresh')) return oldRefresh;
      if (url.endsWith('/oauth/initiate')) return response(200, { auth_url: 'https://auth.example.test/consent' });
      if (url.endsWith('/oauth/token')) return response(200, { access_token: jwt('new-account'), refresh_token: 'new-refresh' });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  values.set('hallyu.rork.access_token', jwt('old-account', true));
  values.set('hallyu.rork.refresh_token', 'old-refresh');
  const refreshing = auth.refreshAccessToken();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const identity = await auth.startGoogleSignIn();
  assert.equal(identity.sub, 'new-account');
  resolveOldRefresh(response(200, { access_token: jwt('old-account') }));
  assert.equal(await refreshing, null);
  assert.equal(auth.identityFromAccessToken(values.get('hallyu.rork.access_token')).sub, 'new-account');
  assert.equal(values.get('hallyu.rork.refresh_token'), 'new-refresh');
});

test('a refreshed JWT for another Rork subject is never adopted', async () => {
  const { auth, values } = loadRork({ fetchImpl: async () => response(200, { access_token: jwt('different-subject') }) });
  const original = jwt('expected-subject', true);
  values.set('hallyu.rork.access_token', original);
  values.set('hallyu.rork.refresh_token', 'refresh');
  assert.equal(await auth.refreshAccessToken(), null);
  assert.equal(values.get('hallyu.rork.access_token'), original);
});

test('registration, AccountSync, and feed refresh retain their honesty invariants', () => {
  const auth = fs.readFileSync('lib/auth.tsx', 'utf8');
  assert.ok(!auth.includes('id: identity.sub'));
  assert.ok(auth.includes(".eq('auth_sub', identity.sub)"));
  assert.ok(auth.includes('generation !== sessionGeneration.current'));
  const migration = fs.readFileSync('supabase/migrations/20261111100000_61_registration_owner_and_ceo_repairs.sql', 'utf8');
  assert.ok(migration.includes("public.generate_handle(coalesce(nullif(btrim(p_handle), ''), 'member'), v_id)"));
  assert.ok(!migration.includes("'member'), v_sub)"));
  assert.ok(migration.includes('on conflict (auth_sub) do nothing;'));
  assert.ok(migration.includes('select id into v_id from public.profiles where auth_sub = v_sub;'));
  assert.ok(migration.includes("pg_advisory_xact_lock(hashtextextended('hallyu:first-profile-owner'"));
  const layout = fs.readFileSync('app/_layout.tsx', 'utf8');
  assert.ok(layout.indexOf('if (!hydrated) throw') < layout.indexOf('applied.current = u.id'));
  const sync = fs.readFileSync('lib/sync.ts', 'utf8');
  assert.ok(sync.includes("fetchFeed('latest', { limit: 25 }),\n      fetchCommunityPulse"));
  assert.ok(sync.includes('export async function refreshSocialFeed'));
  const client = fs.readFileSync('lib/api/client.ts', 'utf8');
  assert.ok(client.includes("!['GET', 'HEAD', 'OPTIONS'].includes(method)"));
});
