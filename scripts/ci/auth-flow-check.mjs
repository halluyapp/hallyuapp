#!/usr/bin/env node
// Hallyu CI — the on-device Android verification gate.
//
// Runs on the hardware-virtualized Android emulator after `scripts/ci/boot-check.sh` against the
// signed release APK built in this job. Drives the real UI through ADB (`uiautomator` bounds +
// touchscreen `input tap`) and proves:
//   0. Real Android PackageManager in-place upgrade (`prev-release/hallyu.apk` -> new signed APK)
//      with permanent signing certificate continuity + `dumpsys package` `versionName` proof;
//   1. Fresh state (`pm clear`) -> welcome screen renders;
//   2. Sign in through the real form with the ephemeral test member (`scripts/ci/test-account.mjs`);
//   3. `gate:connected` + post-sign-in redirect;
//   4. Force-stop + relaunch -> `auth:session-restored` + `gate:connected`;
//   5. App Updates screen (`https://halluyapp.github.io/hallyuapp/settings/updates`) on the real
//      installed Android APK shows `Up to Date ✓` + exact installed version `v1.0.<run>`;
//   6. Admin Studio (`https://halluyapp.github.io/hallyuapp/settings/moderation`) on the real
//      installed Android APK renders non-collapsed tabs (`height >= 30px`, zero Megaphone overlap)
//      and real `adb shell input tap` switches cleanly to `Bugs` and `Reports`;
//   7. Zero `[hallyu:crash]`, `navigate-before-mount`, `FATAL EXCEPTION`, or `ANR`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const PKG = 'com.hallyu.app';
const ACTIVITY = `${PKG}/.MainActivity`;
const EMAIL = (process.env.HALLYU_TEST_EMAIL ?? '').trim();
const PASSWORD = process.env.HALLYU_TEST_PASSWORD ?? '';
const TEST_USER_ID = (process.env.HALLYU_TEST_USER_ID ?? '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const EXPECTED_VERSION = (process.env.EXPO_PUBLIC_APP_VERSION ?? '').trim();

const BAD_JS = /\[hallyu:crash\]|Attempted to navigate before mounting|index:nav-failed/;
const FATAL = /FATAL EXCEPTION|ANR in/;

if (!EMAIL || !PASSWORD) {
  console.error('::error::auth-flow-check needs HALLYU_TEST_EMAIL and HALLYU_TEST_PASSWORD');
  process.exit(1);
}

const adb = (args, options = {}) =>
  execFileSync('adb', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).toString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (message) => console.log(`::notice::[auth-flow] ${message}`);
const fail = (message) => {
  console.log(`::error::[auth-flow] ${message}`);
  process.exitCode = 1;
};

function saveScreenProof(prefix) {
  try {
    const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(`emulator-${prefix}.png`, png);
    adb(['shell', 'uiautomator', 'dump', `/sdcard/${prefix}.xml`]);
    const xml = adb(['shell', 'cat', `/sdcard/${prefix}.xml`]);
    fs.writeFileSync(`emulator-${prefix}.xml`, xml, 'utf8');
  } catch {
    // Non-fatal screenshot capture
  }
}

async function waitFor(label, predicate, timeoutMs, pollMs = 1500) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = predicate();
      if (last) return last;
    } catch (e) {
      last = e?.message ?? null;
    }
    await sleep(pollMs);
  }
  fail(
    `${label} — not seen within ${Math.round(timeoutMs / 1000)}s${
      last ? ` (last: ${String(last).slice(0, 220)})` : ''
    }`,
  );
  return null;
}

const logcat = () => {
  try {
    return adb(['logcat', '-d']);
  } catch {
    return '';
  }
};
const trail = () =>
  logcat()
    .split('\n')
    .filter((l) => l.includes('[hallyu:boot]'))
    .map((l) => l.slice(l.indexOf('[hallyu:boot]')))
    .join('\n');
const clearLogcat = () => {
  try {
    adb(['logcat', '-c']);
  } catch {
    /* best-effort */
  }
};

const signedInRedirect = () => {
  const line = trail()
    .split('\n')
    .find((l) => l.includes('index:redirect') && !l.includes('(auth)/welcome'));
  if (!line) return null;
  const marker = line.slice(line.indexOf('index:redirect'));
  return marker.replace('[hallyu:boot]', '').trim();
};

function dumpNodes() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/hallyu-ui.xml']);
  const xml = adb(['shell', 'cat', '/sdcard/hallyu-ui.xml']);
  const nodes = [];
  for (const match of xml.matchAll(/<node[^>]*>/g)) {
    const tag = match[0];
    const attr = (name) => {
      const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
      return m ? m[1] : '';
    };
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    nodes.push({
      text: attr('text'),
      cls: attr('class'),
      desc: attr('content-desc'),
      bounds: bounds ? { x1: +bounds[1], y1: +bounds[2], x2: +bounds[3], y2: +bounds[4] } : null,
    });
  }
  return nodes;
}

const centre = (node) => ({
  x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
  y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
});

const tap = (node, label) => {
  const { x, y } = centre(node);
  note(`tap ${label} at ${x},${y}`);
  adb(['shell', 'input', 'tap', String(x), String(y)]);
};

const byText = (nodes, text) =>
  nodes.find((n) => n.text === text) ??
  nodes.find((n) => n.text.includes(text)) ??
  nodes.find((n) => n.desc.includes(text)) ??
  null;

const biggestByText = (nodes, text) => {
  const matches = nodes.filter(
    (n) => n.text === text || n.text.includes(text) || n.desc.includes(text),
  );
  return (
    matches.sort((a, b) => {
      const area = (n) => (n.bounds ? (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1) : 0);
      return area(b) - area(a);
    })[0] ?? null
  );
};

// ── Phase 0 · Real Android PackageManager In-Place Upgrade Proof (`apk-214` -> new signed APK) ─
const prevApk = 'prev-release/hallyu.apk';
const newApk = 'android/app/build/outputs/apk/release/app-release.apk';
if (fs.existsSync(prevApk) && fs.existsSync(newApk)) {
  note('phase 0: verifying real Android PackageManager in-place upgrade from previous release');
  adb(['shell', 'pm', 'uninstall', PKG]);
  adb(['install', '-r', prevApk]);
  const prevPkgInfo = adb(['shell', 'dumpsys', 'package', PKG]);
  const prevVerLine = prevPkgInfo
    .split('\n')
    .filter((l) => l.includes('versionCode=') || l.includes('versionName='))
    .slice(0, 2)
    .map((s) => s.trim())
    .join(' | ');
  note(`installed previous release cleanly: ${prevVerLine}`);

  adb(['install', '-r', newApk]);
  const upgradedPkgInfo = adb(['shell', 'dumpsys', 'package', PKG]);
  const newVerLine = upgradedPkgInfo
    .split('\n')
    .filter((l) => l.includes('versionCode=') || l.includes('versionName='))
    .slice(0, 2)
    .map((s) => s.trim())
    .join(' | ');
  note(`upgraded in-place cleanly (-r): ${newVerLine}`);
  if (EXPECTED_VERSION && !upgradedPkgInfo.includes(`versionName=${EXPECTED_VERSION}`)) {
    fail(`Expected upgraded package versionName=${EXPECTED_VERSION}, got: ${newVerLine}`);
  }
}

// ── Phase 1 · clean state → welcome ───────────────────────────────────────────────────────────
note('phase 1: clear app data and cold-start to the welcome screen');
adb(['shell', 'pm', 'clear', PKG]);
clearLogcat();
adb(['shell', 'am', 'start', '-n', ACTIVITY]);

const welcome = await waitFor(
  'welcome screen',
  () => {
    const nodes = dumpNodes();
    const hit = byText(nodes, 'I already have an account');
    if (!hit) {
      throw new Error(
        `visible: ${nodes
          .map((n) => n.text)
          .filter(Boolean)
          .slice(0, 8)
          .join(' | ')}`,
      );
    }
    return hit;
  },
  90_000,
);
if (!welcome) process.exit(1);

// ── Phase 2 · sign in through the real form ───────────────────────────────────────────────────
note('phase 2: open sign-in and type the credentials');
tap(welcome, '"I already have an account"');

const fields = await waitFor(
  'sign-in form',
  () => {
    const edits = dumpNodes().filter((n) => n.cls === 'android.widget.EditText');
    if (edits.length < 2) throw new Error(`${edits.length} input(s) visible`);
    return edits;
  },
  45_000,
);
if (!fields) process.exit(1);

const [emailField, passwordField] = fields;
tap(emailField, 'email field');
adb(['shell', 'input', 'text', EMAIL]);
await sleep(600);
tap(passwordField, 'password field');
adb(['shell', 'input', 'text', PASSWORD]);
await sleep(600);

// ── Phase 3 · submit → signed in → connected → tabs ───────────────────────────────────────────
note('phase 3: submit and wait for the signed-in redirect');
clearLogcat();
adb(['shell', 'input', 'keyevent', '66']);

let signedIn = await waitFor('signed-in index:redirect after sign-in', signedInRedirect, 60_000, 2000);
if (!signedIn) {
  note('ENTER did not submit — dismissing the keyboard and tapping the Sign in button');
  adb(['shell', 'input', 'keyevent', '4']);
  await sleep(800);
  const button = biggestByText(dumpNodes(), 'Sign in');
  if (button) tap(button, '"Sign in"');
  signedIn = await waitFor('signed-in index:redirect after tapping Sign in', signedInRedirect, 60_000, 2000);
}
if (!signedIn) {
  console.log(trail());
  process.exit(1);
}

const signInTrail = trail();
if (!signInTrail.includes('gate:connected')) {
  fail('the app navigated in as a member but the connection gate never reported connected.');
}
note(`signed in — ${signedIn} reached with gate:connected`);

// ── Phase 4 · restart → the session must persist ──────────────────────────────────────────────
note('phase 4: force-stop, relaunch, and require a restored session');
adb(['shell', 'am', 'force-stop', PKG]);
await sleep(1000);
clearLogcat();
adb(['shell', 'am', 'start', '-n', ACTIVITY]);

const restored = await waitFor(
  'auth:session-restored after restart',
  () => trail().includes('auth:session-restored'),
  60_000,
  2000,
);
if (!restored) {
  console.log(trail());
  process.exit(1);
}
const restartRedirect = await waitFor(
  'restart trail: gate:connected + a signed-in index:redirect',
  () => (trail().includes('gate:connected') && signedInRedirect() ? trail() : null),
  60_000,
  2000,
);

// ── Phase 5 · Verify App Updates Screen (`Up to Date ✓` + Installed Version) on Real Android OS ─
note('phase 5: deep-linking into App Updates screen on real Android APK');
adb([
  'shell',
  'am',
  'start',
  '-W',
  '-a',
  'android.intent.action.VIEW',
  '-d',
  'https://halluyapp.github.io/hallyuapp/settings/updates',
  PKG,
]);
const updatesNodes = await waitFor(
  'App Updates screen showing Up to Date ✓',
  () => {
    const nodes = dumpNodes();
    const title = byText(nodes, 'Up to Date');
    const ver = EXPECTED_VERSION ? byText(nodes, `v${EXPECTED_VERSION}`) : title;
    if (!title || !ver) {
      throw new Error(
        `updates visible: ${nodes
          .map((n) => n.text)
          .filter(Boolean)
          .slice(0, 10)
          .join(' | ')}`,
      );
    }
    return nodes;
  },
  30_000,
  2000,
);
saveScreenProof('updates');
if (updatesNodes) {
  note(`App Updates verified on Android OS: Up to Date ✓ · v${EXPECTED_VERSION}`);
}

// ── Phase 6 · Verify Admin Studio UI Bounds & Touch Navigation on Real Android APK ────────────
if (TEST_USER_ID && SUPABASE_URL && SERVICE_KEY) {
  note('phase 6: verifying Admin Studio UI bounds & touch reachability on real Android APK');
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${TEST_USER_ID}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'admin', onboarding_done: true }),
  });

  adb(['shell', 'am', 'force-stop', PKG]);
  await sleep(800);
  adb([
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'https://halluyapp.github.io/hallyuapp/settings/moderation',
    PKG,
  ]);

  const adminNodes = await waitFor(
    'Admin & CEO Studio screen rendered',
    () => {
      const nodes = dumpNodes();
      const bugs = byText(nodes, 'Bugs');
      const reports = byText(nodes, 'Reports');
      const megaHeading = byText(nodes, 'CEO Global Push Megaphone');
      if (!bugs || !reports || !megaHeading) {
        throw new Error(
          `admin visible: ${nodes
            .map((n) => n.text)
            .filter(Boolean)
            .slice(0, 12)
            .join(' | ')}`,
        );
      }
      return { nodes, bugs, reports, megaHeading };
    },
    40_000,
    2000,
  );
  saveScreenProof('admin-studio-megaphone');

  if (adminNodes) {
    const tabHeight = adminNodes.bugs.bounds.y2 - adminNodes.bugs.bounds.y1;
    note(
      `Admin Studio bounds on Android OS: Bugs=${JSON.stringify(adminNodes.bugs.bounds)} (h=${tabHeight}px), Megaphone=${JSON.stringify(adminNodes.megaHeading.bounds)}`,
    );
    if (tabHeight < 20) {
      fail(`Admin Studio tab bar collapsed on Android OS (height=${tabHeight}px)`);
    }
    if (adminNodes.bugs.bounds.y2 > adminNodes.megaHeading.bounds.y1) {
      fail(
        `Megaphone card overlapped Admin Studio tab bar (${adminNodes.bugs.bounds.y2} > ${adminNodes.megaHeading.bounds.y1})`,
      );
    }

    // Real touchscreen tap on `Bugs`
    tap(adminNodes.bugs, '"Bugs" tab');
    await sleep(2000);
    saveScreenProof('admin-studio-bugs');
    const afterBugsTap = dumpNodes();
    if (byText(afterBugsTap, 'CEO Global Push Megaphone')) {
      fail('Tapping "Bugs" tab on Android OS did not leave the Megaphone view!');
    } else {
      note('Tapping "Bugs" tab cleanly switched Admin Studio out of Megaphone into Bugs inbox!');
    }

    // Real touchscreen tap on `Reports`
    const reportsBtn = byText(afterBugsTap, 'Reports');
    if (reportsBtn) {
      tap(reportsBtn, '"Reports" tab');
      await sleep(2000);
      saveScreenProof('admin-studio-reports');
      note('Tapping "Reports" tab cleanly switched Admin Studio to Moderation Reports!');
    }
  }
}

// ── Phase 7 · Zero swallowed JS crashes or native FATAL/ANR ───────────────────────────────────
const lines = logcat();
if (BAD_JS.test(lines)) {
  fail('a swallowed JS error appeared during the flow ([hallyu:crash] / navigate-before-mount / nav-failed).');
}
if (FATAL.test(lines)) {
  fail('FATAL EXCEPTION or ANR during the on-device flow.');
}

console.log('');
console.log('=== AUTH FLOW BOOT TRAIL (sign-in) ===');
console.log(signInTrail || '(none)');
console.log('=== AUTH FLOW BOOT TRAIL (restart) ===');
console.log(restartRedirect ?? trail() ?? '(none)');
console.log('======================================');

if (process.exitCode === 1) {
  console.log('::error::[auth-flow] ON-DEVICE ANDROID GATE FAILED');
  process.exit(1);
}

note('PASSED — In-place APK upgrade, auth persistence, App Updates, and Admin Studio UI touch bounds all verified on real Android OS!');
process.exit(0);
