#!/usr/bin/env node
/**
 * Post-processes Expo Web SPA `dist/index.html` so Apple iPhone/iPad Safari ("Add to Home Screen"),
 * Android Chrome PWA, and OpenGraph social link previews receive full metadata at root
 * `https://hallyuapp.github.io` (or an optional `EXPO_PUBLIC_BASE_PATH` preview subpath),
 * then mirrors `dist/index.html` -> `dist/404.html` + `dist/.nojekyll` for SPA deep-link routing.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const distDir = path.resolve(process.argv[2] || 'dist');
const indexPath = path.join(distDir, 'index.html');
const basePath = (process.env.EXPO_PUBLIC_BASE_PATH || '').trim().replace(/\/$/, '');
const assetPrefix = basePath || '';
const canonicalSiteUrl = basePath
  ? `https://macaulay-spec.github.io${basePath}`
  : 'https://hallyuapp.github.io';

if (!fs.existsSync(indexPath)) {
  console.error(`Missing ${indexPath}`);
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

const headInjection = `
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

fs.writeFileSync(indexPath, html, 'utf8');
fs.copyFileSync(indexPath, path.join(distDir, '404.html'));
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

console.log(
  `Enhanced ${indexPath}, created 404.html + .nojekyll (canonical=${canonicalSiteUrl}, assetPrefix="${assetPrefix || '/'}")`,
);
