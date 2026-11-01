/**
 * Release retention for the public `app-releases` bucket.
 *
 * Pure planning lives here so it can be unit-tested without touching storage.
 * The publisher calls `planRetention` only after a new release is uploaded, its manifest is
 * verified and its `app_releases` row is written. Failure at any earlier step never reaches here.
 *
 * Rules (a folder is deleted only when every rule says it is not needed):
 *   - The current release folder is always kept.
 *   - The previous published release (next lower version code) is kept for rollback.
 *   - Any folder still referenced by an `app_releases` row (`universal_apk_url`, `apk_url`) is kept.
 *   - Folders that do not match `releases/v<semver>/` are never touched.
 *   - If the current version is not in the folder list, or the release table could not be read,
 *     nothing is deleted.
 */

const VERSION_FOLDER = /^v(\d+\.\d+\.\d+)$/;

/** Extracts `v1.2.3` from a storage URL such as `.../releases/v1.2.3/hallyu-universal.apk`. */
export function folderFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /\/releases\/(v\d+\.\d+\.\d+)\//.exec(url);
  return m ? m[1] : null;
}

/**
 * @param {object} input
 * @param {string[]} input.folders           folder names in `releases/` (e.g. `v1.0.291`)
 * @param {string} input.currentVersion      version being published (e.g. `1.0.292`)
 * @param {Array<{version_name: string, version_code: number, universal_apk_url?: string|null, apk_url?: string|null}>} input.releases
 * @returns {{ keep: string[], remove: string[], reason: string | null }}
 */
export function planRetention({ folders, currentVersion, releases }) {
  if (!Array.isArray(folders) || !Array.isArray(releases) || typeof currentVersion !== 'string') {
    return { keep: [], remove: [], reason: 'invalid input' };
  }
  const currentFolder = `v${currentVersion}`;
  if (!folders.includes(currentFolder)) {
    return { keep: [], remove: [], reason: `current folder ${currentFolder} is missing; nothing deleted` };
  }

  const current = releases.find((r) => r.version_name === currentVersion);
  const currentCode = current ? Number(current.version_code) : Number.POSITIVE_INFINITY;
  const previous = releases
    .filter((r) => r.version_name !== currentVersion && Number(r.version_code) < currentCode)
    .sort((a, b) => Number(b.version_code) - Number(a.version_code))[0];

  const keep = new Set([currentFolder]);
  if (previous) keep.add(`v${previous.version_name}`);
  for (const r of releases) {
    const a = folderFromUrl(r.universal_apk_url);
    const b = folderFromUrl(r.apk_url);
    if (a) keep.add(a);
    if (b) keep.add(b);
  }

  const remove = [];
  for (const name of folders) {
    if (!VERSION_FOLDER.test(name)) continue; // never touch anything we do not recognise
    if (!keep.has(name)) remove.push(name);
  }
  remove.sort();
  return { keep: [...keep].filter((k) => folders.includes(k)).sort(), remove, reason: null };
}

/**
 * Deletion is OFF by default. Only HALLYU_RETENTION_APPLY=1 allows deletion; anything else is a dry run
 * that logs what would be removed. This keeps a live bucket safe until the delete path is verified.
 */
export function retentionDryRun(env = process.env) {
  return env.HALLYU_RETENTION_APPLY !== '1';
}
