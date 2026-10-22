#!/usr/bin/env node
/**
 * Configures permanent 4096-bit PKCS12 release signing + ABI split APKs (Slim ARM64 + Universal)
 * inside generated `android/app/build.gradle` after `npx expo prebuild --platform android`.
 *
 * Zero secrets are ever stored in Git: credentials arrive solely through masked CI environment
 * variables materialized in the ephemeral runner workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const gradlePath = path.resolve('android/app/build.gradle');
if (!fs.existsSync(gradlePath)) {
  console.error(`Missing ${gradlePath} — run expo prebuild first.`);
  process.exit(1);
}

const keystoreB64 = (process.env.ANDROID_KEYSTORE_BASE64 ?? '').trim();
const storePassword = (process.env.ANDROID_KEYSTORE_PASSWORD ?? '').trim();
const keyAlias = (process.env.ANDROID_KEY_ALIAS ?? '').trim();
const keyPassword = (process.env.ANDROID_KEY_PASSWORD ?? '').trim();
const baseVersionCode = Number.parseInt(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? '10000', 10);

if (!keystoreB64 || !storePassword || !keyAlias || !keyPassword) {
  console.error('Missing permanent release signing environment variables.');
  process.exit(1);
}

const keystoreDest = path.resolve('android/app/hallyu-release.p12');
fs.writeFileSync(keystoreDest, Buffer.from(keystoreB64, 'base64'));

let src = fs.readFileSync(gradlePath, 'utf8');

if (!src.includes('hallyuReleaseSigning')) {
  const signingNeedle = /signingConfigs\s*\{/;
  if (!signingNeedle.test(src)) {
    console.error('Could not locate signingConfigs block in android/app/build.gradle');
    process.exit(1);
  }

  // Inject BOTH ABI splits + monotonic per-ABI versionCode AND permanent PKCS12 signing right
  // inside `android { ... }` immediately above `signingConfigs { ... }`.
  const injectedAndroidConfig = `splits {
        abi {
            enable true
            reset()
            include "arm64-v8a", "armeabi-v7a", "x86_64"
            universalApk true
        }
    }

    applicationVariants.all { variant ->
        def abiCodes = ["armeabi-v7a": 2, "x86_64": 3, "arm64-v8a": 4]
        variant.outputs.each { output ->
            def abiFilter = output.getFilter(com.android.build.OutputFile.ABI)
            def offset = abiFilter == null ? 1 : (abiCodes.get(abiFilter) ?: 1)
            output.versionCodeOverride = ${baseVersionCode} + offset
        }
    }

    signingConfigs {
        release { // hallyuReleaseSigning
            storeFile file('hallyu-release.p12')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEY_PASSWORD')
            storeType 'PKCS12'
        }`;

  src = src.replace(signingNeedle, injectedAndroidConfig);

  // Switch buildTypes signingConfig -> signingConfigs.release across every buildType
  src = src.replace(
    /signingConfig\s+signingConfigs\.debug/g,
    'signingConfig signingConfigs.release',
  );

  fs.writeFileSync(gradlePath, src, 'utf8');
}

console.log(
  `Configured permanent PKCS12 release signing + Slim ARM64 / Universal splits inside android {} (base versionCode ${baseVersionCode}).`,
);
