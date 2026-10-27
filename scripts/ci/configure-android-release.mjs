#!/usr/bin/env node
/**
 * Configures permanent 4096-bit PKCS12 release signing + ALL 4 ABI splits (`arm64-v8a`,
 * `armeabi-v7a`, `x86_64`, `x86`) + True 4-ABI Universal APK (`universalApk true`), enables
 * `useLegacyPackaging true` (`android:extractNativeLibs="true"`) for full Android 15/16 16 KB
 * memory-page compatibility and ~50% smaller compressed downloads, stamps explicit `versionName`,
 * and injects `HallyuApkInstallerModule.kt` into `MainApplication.kt`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { injectNativeApkInstallerModule } from './android-installer-module.mjs';
import { injectNativeDownloaderModule } from './android-downloader-module.mjs';

const gradlePath = path.resolve('android/app/build.gradle');
const gradlePropsPath = path.resolve('android/gradle.properties');
if (!fs.existsSync(gradlePath)) {
  console.error(`Missing ${gradlePath} — run expo prebuild first.`);
  process.exit(1);
}

const keystoreB64 = (process.env.ANDROID_KEYSTORE_BASE64 ?? '').trim();
const storePassword = (process.env.ANDROID_KEYSTORE_PASSWORD ?? '').trim();
const keyAlias = (process.env.ANDROID_KEY_ALIAS ?? '').trim();
const keyPassword = (process.env.ANDROID_KEY_PASSWORD ?? '').trim();
const baseVersionCode = Number.parseInt(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? '10000', 10);
const appVersion = (
  process.env.EXPO_PUBLIC_APP_VERSION ??
  `1.0.${Math.max(1, Math.floor(baseVersionCode / 10) - 1000)}`
).trim();

if (!keystoreB64 || !storePassword || !keyAlias || !keyPassword) {
  console.error('Missing permanent release signing environment variables.');
  process.exit(1);
}

const keystoreDest = path.resolve('android/app/hallyu-release.p12');
fs.writeFileSync(keystoreDest, Buffer.from(keystoreB64, 'base64'));

// Enable Expo / AGP jniLibs legacy packaging (`android:extractNativeLibs="true"`):
// 1. Makes NDK r26 native `.so` binaries install & execute cleanly on BOTH 4 KB devices AND
//    Android 15 / 16 16 KB memory-page devices (Pixel 8/9/10, newer Samsung/Xiaomi flagships).
// 2. Compresses `.so` binaries inside the APK (~18 MB per-ABI splits, ~40 MB 4-ABI Universal APK).
if (fs.existsSync(gradlePropsPath)) {
  let props = fs.readFileSync(gradlePropsPath, 'utf8');
  if (/^expo\.useLegacyPackaging=/m.test(props)) {
    props = props.replace(/^expo\.useLegacyPackaging=.*$/m, 'expo.useLegacyPackaging=true');
  } else {
    props = `${props.trimEnd()}\nexpo.useLegacyPackaging=true\n`;
  }
  fs.writeFileSync(gradlePropsPath, props, 'utf8');
}

let src = fs.readFileSync(gradlePath, 'utf8');

// Guarantee explicit `versionName` matches the release train (never left at default `1.0.0`)
src = src.replace(/versionName\s+"[^"]*"/, `versionName "${appVersion}"`);

// Guarantee explicit `useLegacyPackaging true` inside `packagingOptions.jniLibs`
src = src.replace(
  /useLegacyPackaging\s*\([^\n]*\)/g,
  'useLegacyPackaging true',
);

if (!src.includes('hallyuReleaseSigning')) {
  const signingNeedle = /signingConfigs\s*\{/;
  if (!signingNeedle.test(src)) {
    console.error('Could not locate signingConfigs block in android/app/build.gradle');
    process.exit(1);
  }

  // Monotonic ABI ordering within every release train `base`:
  //   x86         -> base + 1
  //   armeabi-v7a -> base + 2
  //   x86_64      -> base + 3
  //   arm64-v8a   -> base + 4
  //   universal   -> base + 5  (highest in train — can upgrade over any split of same or older train,
  //                             and every split in next train `base + 10` is strictly higher!)
  const injectedAndroidConfig = `splits {
        abi {
            enable true
            reset()
            include "arm64-v8a", "armeabi-v7a", "x86_64", "x86"
            universalApk true
        }
    }

    applicationVariants.all { variant ->
        def abiCodes = ["x86": 1, "armeabi-v7a": 2, "x86_64": 3, "arm64-v8a": 4]
        variant.outputs.each { output ->
            def abiFilter = output.getFilter(com.android.build.OutputFile.ABI)
            def offset = abiFilter == null ? 5 : (abiCodes.get(abiFilter) ?: 5)
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
            enableV1Signing true
            enableV2Signing true
            enableV3Signing true
        }`;

  src = src.replace(signingNeedle, injectedAndroidConfig);

  src = src.replace(
    /signingConfig\s+signingConfigs\.debug/g,
    'signingConfig signingConfigs.release',
  );
}

fs.writeFileSync(gradlePath, src, 'utf8');

injectNativeApkInstallerModule(path.resolve('android'));
injectNativeDownloaderModule(path.resolve('android'));

console.log(
  `Configured permanent PKCS12 v1+v2+v3 signing + useLegacyPackaging=true + HallyuApkInstaller + 4 ABI splits + Universal (${appVersion}, base ${baseVersionCode}).`,
);
