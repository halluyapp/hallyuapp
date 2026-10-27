#!/usr/bin/env node
/**
 * Post-processes Expo Web SPA `dist/` bundle for production deployment:
 *   1. Injects build verification meta tags (`hallyu-commit`, `hallyu-version`, `hallyu-built-at`),
 *      HTML `no-cache` directives, PWA / Apple Home Screen metadata, and OpenGraph social cards.
 *   2. Stamps `SW_BUILD_ID` inside `dist/sw.js` so browsers detect every new deployment automatically
 *      and evict superseded asset caches on `activate`.
 *   3. Emits machine-verifiable `dist/version.json` mapping the exact deployed site back to the
 *      Git commit SHA, build timestamp, and hashed entry JS bundle filename.
 *   4. Creates `dist/404.html`, `dist/.nojekyll`, and copies `public/.well-known/assetlinks.json`.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const distDir = path.resolve(process.argv[2] || 'dist');
const indexPath = path.join(distDir, 'index.html');
const basePath = (process.env.EXPO_PUBLIC_BASE_PATH || '').trim().replace(/\/$/, '');
const assetPrefix = basePath || '';
const ghOwner = (process.env.GITHUB_REPOSITORY_OWNER || 'halluyapp').trim().toLowerCase();
const canonicalSiteUrl = basePath
  ? `https://${ghOwner}.github.io${basePath}`
  : 'https://hallyuapp.github.io';

function readGitValue(cmd, fallback = 'unknown') {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const commitFull = (
  process.env.EXPO_PUBLIC_GIT_COMMIT ||
  process.env.GITHUB_SHA ||
  readGitValue('git rev-parse HEAD')
).trim();
const commitShort = (
  process.env.EXPO_PUBLIC_GIT_SHORT ||
  commitFull.slice(0, 7) ||
  readGitValue('git rev-parse --short HEAD')
).trim();
const appVersion = (process.env.EXPO_PUBLIC_APP_VERSION || '1.0.0').trim();
const builtAt = (process.env.EXPO_PUBLIC_BUILT_AT || new Date().toISOString()).trim();
const swBuildId = `${commitShort}-${builtAt.replace(/[^0-9A-Za-z]/g, '').slice(0, 14)}`;

if (!fs.existsSync(indexPath)) {
  console.error(`Missing ${indexPath}`);
  process.exit(1);
}

// Verify hashed JS bundle output exists under `_expo/static/js/web/`
const jsWebDir = path.join(distDir, '_expo/static/js/web');
const entryBundles = fs.existsSync(jsWebDir)
  ? fs.readdirSync(jsWebDir).filter((f) => f.endsWith('.js'))
  : [];
if (entryBundles.length === 0) {
  console.error(`Missing content-hashed web JS bundle in ${jsWebDir}`);
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

const headInjection = `
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <meta name="hallyu-version" content="${appVersion}" />
    <meta name="hallyu-commit" content="${commitFull}" />
    <meta name="hallyu-built-at" content="${builtAt}" />
    <meta name="theme-color" content="#000000" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Hallyu" />
    <meta name="description" content="Every episode night. Together. Live Watch Parties, social reactions, DMs & spoiler-safe threads across K-Dramas, C-Dramas, Anime & Cinema." />
    <meta property="og:site_name" content="Hallyu" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${canonicalSiteUrl}/" />
    <meta property="og:title" content="Hallyu — Every Episode Night. Together." />
    <meta property="og:description" content="Join synchronized Watch Parties, vote in episode predictions, react live with friends & track K-Dramas, C-Dramas, Anime & Cinema." />
    <meta property="og:image" content="${canonicalSiteUrl}/apple-touch-icon.png" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="Hallyu — Every Episode Night. Together." />
    <link rel="manifest" href="${assetPrefix}/manifest.json" />
    <link rel="apple-touch-icon" href="${assetPrefix}/apple-touch-icon.png" />
    <style>html, body, #root { background-color: #000000 !important; color: #F5F5F7; }</style>
`;

html = html
  .replace('<title>Hallyu</title>', '<title>Hallyu — Every Episode Night. Together.</title>')
  .replace('</head>', `${headInjection}\n  </head>`);

// Stamp `SW_BUILD_ID` inside `dist/sw.js` so every deployed commit triggers clean SW update
const swPath = path.join(distDir, 'sw.js');
if (fs.existsSync(swPath)) {
  const swRaw = fs.readFileSync(swPath, 'utf8');
  fs.writeFileSync(swPath, swRaw.replace(/__HALLYU_SW_BUILD_ID__/g, swBuildId), 'utf8');
}

// Ensure manifest start_url / scope / icon paths match root vs subpath deployment cleanly
const manifestPath = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.start_url = `${assetPrefix}/`;
  manifest.scope = `${assetPrefix}/`;
  manifest.icons = (manifest.icons || []).map((icon) => ({
    ...icon,
    src: `${assetPrefix}/apple-touch-icon.png`,
  }));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// Write machine-verifiable build provenance manifest `dist/version.json`
const versionManifest = {
  app: 'hallyu-web',
  version: appVersion,
  commit: commitFull,
  commitShort,
  builtAt,
  swBuildId,
  basePath: assetPrefix || '/',
  canonicalSiteUrl,
  entryBundles,
};
fs.writeFileSync(
  path.join(distDir, 'version.json'),
  `${JSON.stringify(versionManifest, null, 2)}\n`,
  'utf8',
);

fs.writeFileSync(indexPath, html, 'utf8');
fs.copyFileSync(indexPath, path.join(distDir, '404.html'));
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

// Copy hidden `public/.well-known` directory (skipped by Metro static asset copier due to leading dot)
const publicWellKnown = path.resolve('public/.well-known');
if (fs.existsSync(publicWellKnown)) {
  fs.cpSync(publicWellKnown, path.join(distDir, '.well-known'), { recursive: true });
}

console.log(
  `Enhanced ${indexPath}, stamped sw.js (${swBuildId}), emitted version.json (${commitShort}), verified ${entryBundles.length} hashed bundle(s).`,
);
