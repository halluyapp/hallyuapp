#!/usr/bin/env node
/**
 * Materializes ephemeral Android signing & Firebase push configuration at CI build time from
 * GitHub Actions Secrets OR `public.ci_build_vault` (RLS-locked strictly to `service_role`).
 *
 * Security invariants:
 *   - Masks every secret value via `::add-mask::` before writing to `$GITHUB_ENV`.
 *   - Never commits or persists credentials into Git or client JS bundles.
 */
import fs from 'node:fs';
import process from 'node:process';

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

const vault = new Map();
if (supabaseUrl && serviceKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/ci_build_vault?select=key,value&key=in.(android_keystore_b64,android_keystore_password,android_key_alias,google_services_json_b64)`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed reading ci_build_vault (${res.status}): ${await res.text()}`);
  }
  const rows = await res.json();
  for (const r of rows) {
    if (r?.key && typeof r?.value === 'string') {
      vault.set(r.key, r.value.trim());
    }
  }
}

const googleServicesB64 = (
  process.env.GOOGLE_SERVICES_JSON_BASE64 ||
  vault.get('google_services_json_b64') ||
  ''
).trim();
const keystoreB64 = (
  process.env.ANDROID_KEYSTORE_BASE64 ||
  vault.get('android_keystore_b64') ||
  ''
).trim();
const keystorePass = (
  process.env.ANDROID_KEYSTORE_PASSWORD ||
  vault.get('android_keystore_password') ||
  ''
).trim();
const keyAlias = (
  process.env.ANDROID_KEY_ALIAS ||
  vault.get('android_key_alias') ||
  'hallyu-release'
).trim();
const keyPass = (process.env.ANDROID_KEY_PASSWORD || keystorePass).trim();

if (!googleServicesB64) {
  throw new Error('Missing Firebase Android client config (google_services_json_b64)');
}
if (!keystoreB64 || !keystorePass || !keyAlias) {
  throw new Error('Missing permanent Android release keystore credentials');
}

// Mask every sensitive string in GitHub Actions logs immediately
for (const secret of [keystoreB64, keystorePass, keyPass]) {
  for (const line of secret.split('\n')) {
    if (line.trim()) console.log(`::add-mask::${line.trim()}`);
  }
}

fs.writeFileSync('google-services.json', Buffer.from(googleServicesB64, 'base64'));
console.log(`Materialized google-services.json (${fs.statSync('google-services.json').size} bytes)`);

if (process.env.GITHUB_ENV) {
  const envLines = [
    `ANDROID_KEYSTORE_BASE64=${keystoreB64}`,
    `ANDROID_KEYSTORE_PASSWORD=${keystorePass}`,
    `ANDROID_KEY_ALIAS=${keyAlias}`,
    `ANDROID_KEY_PASSWORD=${keyPass}`,
  ];
  fs.appendFileSync(process.env.GITHUB_ENV, `${envLines.join('\n')}\n`, 'utf8');
  console.log('Exported masked Android release signing keys to GITHUB_ENV');
}
