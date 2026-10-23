/**
 * Normalizes incoming Android App Links, Universal Links, and custom `hallyu://` deep links
 * before Expo Router resolves the native screen stack:
 *   1. Strips GitHub Pages subpath prefix `/hallyuapp` (`https://halluyapp.github.io/hallyuapp/...` -> `/...`)
 *   2. Normalizes short share profile links (`/u/<handle>` -> `/user/<handle>`)
 *   3. Normalizes legacy notification deep links (`/notifications` -> `/(tabs)/activity`)
 */
export function normalizeIncomingNativePath(rawPath: string): string {
  if (!rawPath) return '/';

  let clean = rawPath.trim();

  // Extract pathname + search if a full URL or scheme URI (`https://...` or `hallyu://...`) was passed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) {
    try {
      const parsed = new URL(clean);
      const hostPart =
        parsed.protocol === 'hallyu:' && parsed.hostname
          ? `/${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
          : parsed.pathname;
      clean = `${hostPart || '/'}${parsed.search || ''}`;
    } catch {
      clean = clean.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/+/, '/');
    }
  }

  clean = clean.replace(/^\/+/, '/');

  // Strip GitHub Pages deployment base path `/hallyuapp`
  if (clean === '/hallyuapp' || clean === '/hallyuapp/') {
    clean = '/';
  } else if (clean.startsWith('/hallyuapp/')) {
    clean = clean.slice('/hallyuapp'.length);
  } else if (clean.startsWith('/hallyuapp?')) {
    clean = `/${clean.slice('/hallyuapp'.length)}`;
  }

  const qIdx = clean.indexOf('?');
  const pathname = qIdx >= 0 ? clean.slice(0, qIdx) : clean;
  const search = qIdx >= 0 ? clean.slice(qIdx) : '';

  if (pathname === '/notifications' || pathname === '/notifications/') {
    return `/(tabs)/activity${search}`;
  }

  if (pathname.startsWith('/u/') && pathname.length > 3) {
    const rest = pathname.slice(3).replace(/^@/, '');
    return `/user/${rest}${search}`;
  }

  return `${pathname || '/'}${search}`;
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return normalizeIncomingNativePath(path);
}
