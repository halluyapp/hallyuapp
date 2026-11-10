// Zero-secret CI client for the backend's `ci-gateway` edge function.
//
// Identity: a short-lived GitHub OIDC token minted by the runner (requires
// `permissions: id-token: write`). The gateway verifies it against GitHub's public JWKS and
// only answers the exact repository it serves. No long-lived CI credential exists anywhere.
//
// Usage:
//   node ci-gateway-client.mjs client-env
//       Fetches the CLIENT-SAFE backend values (backend URL, anon key, Rork app key, media
//       bucket) and exports them to $GITHUB_ENV so the JS bundle embeds the right backend.
//   node ci-gateway-client.mjs vault-ensure
//       Reads the signing material from the server-side vault; on first run generates a fresh
//       4096-bit PKCS12 keystore, seeds it (once — later runs reuse the stored keys), and
//       exports ANDROID_KEYSTORE_* to $GITHUB_ENV for configure-android-release.mjs.
//   node ci-gateway-client.mjs publish <apk> --version-code N --version-name X --sha256 S
//            --size N --notes "..." --commit SHA
//       Uploads the universal APK and registers the release through the gateway.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const GATEWAY = (process.env.CI_GATEWAY_URL ?? '').replace(/\/$/, '');
if (!GATEWAY) {
  console.error('::error title=CI gateway missing::CI_GATEWAY_URL is not set.');
  process.exit(1);
}

/** Minimal-but-valid Firebase config: keeps the google-services gradle plugin happy when no
 *  real FCM project is wired up yet (push notifications degrade honestly; the build stays green). */
const FALLBACK_GOOGLE_SERVICES = JSON.stringify({
  project_info: { project_number: '0', project_id: 'hallyu-fallback', storage_bucket: 'hallyu-fallback.appspot.com' },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '1:0:android:0000000000000000000000',
        android_client_info: { package_name: 'com.hallyu.app' },
      },
      oauth_client: [],
      api_key: [{ current_key: 'AIzaSyA00000000000000000000000000000000' }],
    },
  ],
  configuration_version: '1',
});

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !tok) {
    throw new Error('OIDC is unavailable — add `permissions: { id-token: write }` to the workflow.');
  }
  const res = await fetch(`${url}&audience=hallyu-ci`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`could not mint OIDC token: HTTP ${res.status}`);
  const { value } = await res.json();
  if (!value) throw new Error('could not mint OIDC token: empty value');
  return value;
}

async function callGateway(action, init = {}) {
  const res = await fetch(GATEWAY, {
    ...init,
    method: 'POST',
    headers: {
      'x-ci-action': action,
      Authorization: `Bearer ${await oidcToken()}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`gateway ${action} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

function mask(value) {
  for (const line of value.split('\n')) {
    if (line.trim()) console.log(`::add-mask::${line.trim()}`);
  }
}

function exportGithubEnv(lines) {
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`, 'utf8');
    console.log('Exported signing material to GITHUB_ENV');
  }
}

async function clientEnv() {
  const env = await callGateway('client.env');
  const required = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];
  for (const k of required) {
    if (!env[k]) throw new Error(`gateway did not return ${k} — the function runtime is missing it`);
  }
  if (env.EXPO_PUBLIC_SUPABASE_ANON_KEY) mask(env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
  if (env.EXPO_PUBLIC_RORK_APP_KEY) mask(env.EXPO_PUBLIC_RORK_APP_KEY);
  exportGithubEnv(Object.entries(env).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`));
  console.log(`Backend for this build: ${env.EXPO_PUBLIC_SUPABASE_URL}`);
}

async function vaultEnsure() {
  let { vault } = await callGateway('vault.get');

  if (!vault.android_keystore_b64) {
    console.log('First release on this backend: generating a fresh permanent signing keystore…');
    const pass = `Hallyu-${crypto.randomUUID().replace(/-/g, '')}!9`;
    const keystorePath = '/tmp/hallyu-release.p12';
    execFileSync(
      'keytool',
      [
        '-genkeypair',
        '-keyalg', 'RSA',
        '-keysize', '4096',
        '-validity', '10950',
        '-storetype', 'PKCS12',
        '-keystore', keystorePath,
        '-storepass', pass,
        '-keypass', pass,
        '-alias', 'hallyu-release',
        '-dname', 'CN=Hallyu Release, OU=Hallyu, O=Hallyu, C=US',
      ],
      { stdio: 'inherit' },
    );
    const keystoreB64 = fs.readFileSync(keystorePath).toString('base64');
    const googleB64 = fs.existsSync('google-services.json')
      ? fs.readFileSync('google-services.json').toString('base64')
      : Buffer.from(FALLBACK_GOOGLE_SERVICES).toString('base64');
    const seeded = await callGateway('vault.seed', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        android_keystore_b64: keystoreB64,
        android_keystore_password: pass,
        android_key_alias: 'hallyu-release',
        android_key_password: pass,
        google_services_json_b64: googleB64,
      }),
    });
    vault = seeded.vault;
    console.log('Keystore seeded into the server-side vault — every future build reuses it.');
  }

  for (const k of ['android_keystore_b64', 'android_keystore_password', 'android_key_password']) {
    if (vault[k]) mask(vault[k]);
  }
  const keystorePass = vault.android_keystore_password ?? '';
  const keyPass = vault.android_key_password ?? keystorePass;
  exportGithubEnv([
    `ANDROID_KEYSTORE_BASE64=${vault.android_keystore_b64 ?? ''}`,
    `ANDROID_KEYSTORE_PASSWORD=${keystorePass}`,
    `ANDROID_KEY_ALIAS=${vault.android_key_alias ?? 'hallyu-release'}`,
    `ANDROID_KEY_PASSWORD=${keyPass}`,
  ]);

  const googleB64 = vault.google_services_json_b64;
  if (googleB64) {
    fs.writeFileSync('google-services.json', Buffer.from(googleB64, 'base64'));
    console.log(`Materialized google-services.json (${fs.statSync('google-services.json').size} bytes)`);
  }
}

async function publish(apkPath, meta) {
  const apk = fs.readFileSync(apkPath);
  if (apk.byteLength < 1_000_000) throw new Error(`${apkPath} is too small to be an APK`);
  console.log(`Uploading ${apkPath} (${(apk.byteLength / 1024 / 1024).toFixed(1)} MB) via the CI gateway…`);
  const result = await callGateway('release.publish', {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'x-ci-version-code': meta.versionCode,
      'x-ci-version-name': meta.versionName,
      'x-ci-sha256': meta.sha256,
      'x-ci-release-notes': meta.notes,
      'x-ci-git-commit': meta.commit,
      'Content-Length': String(apk.byteLength),
    },
    body: apk,
  });
  if (!result.published) throw new Error('gateway did not confirm the publish');
  console.log(`::notice title=Universal APK published::${result.apk_url}`);
}

const [, , command, ...args] = process.argv;
try {
  if (command === 'client-env') {
    await clientEnv();
  } else if (command === 'vault-ensure') {
    await vaultEnsure();
  } else if (command === 'publish') {
    const apkPath = args[0];
    const get = (flag) => {
      const i = args.indexOf(flag);
      return i >= 0 ? (args[i + 1] ?? '') : '';
    };
    await publish(apkPath, {
      versionCode: get('--version-code') || '0',
      versionName: get('--version-name') || '',
      sha256: get('--sha256') || '',
      notes: get('--notes') || 'Signed Hallyu update.',
      commit: get('--commit') || '',
    });
  } else {
    console.error('usage: ci-gateway-client.mjs client-env | vault-ensure | publish <apk> [flags]');
    process.exit(2);
  }
} catch (e) {
  console.error(`::error title=CI gateway client failed::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
