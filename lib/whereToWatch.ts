/**
 * "Where to watch" — official links only.
 *
 * Hallyu never plays third-party streams. A streaming service name is shown as a link that opens that
 * service's own website or app in the browser. Netflix and Viki have public search pages that take the
 * title as a query. Disney+ search is not publicly routable, so it opens the Disney+ home page.
 * Services not listed here stay as plain labels.
 */
export interface OfficialWatchLink {
  service: 'netflix' | 'viki' | 'disney';
  label: string;
  url: string;
  /** Honest description of what the link does, shown to the member. */
  hint: string;
}

const SERVICES: { service: OfficialWatchLink['service']; match: string; label: string; build: (title: string) => string; hint: string }[] = [
  {
    service: 'netflix',
    match: 'netflix',
    label: 'Netflix',
    build: (t) => `https://www.netflix.com/search?q=${encodeURIComponent(t)}`,
    hint: 'Searches Netflix for this title. Netflix may ask you to sign in.',
  },
  {
    service: 'viki',
    match: 'viki',
    label: 'Viki',
    build: (t) => `https://www.viki.com/search?q=${encodeURIComponent(t)}`,
    hint: 'Searches Viki for this title.',
  },
  {
    service: 'disney',
    match: 'disney',
    label: 'Disney+',
    build: () => 'https://www.disneyplus.com/home',
    hint: 'Opens Disney+. Search for the title there.',
  },
];

/** Returns the official link for a provider name (e.g. "Netflix"), or null if none is supported. */
export function officialWatchLink(providerName: string, title: string): OfficialWatchLink | null {
  const low = providerName.toLowerCase();
  const hit = SERVICES.find((s) => low.includes(s.match));
  if (!hit) return null;
  return { service: hit.service, label: hit.label, url: hit.build(title), hint: hit.hint };
}

/** The three services Explore links to, for a given title (or none). */
export function exploreWatchLinks(title?: string): OfficialWatchLink[] {
  return SERVICES.map((s) => ({ service: s.service, label: s.label, url: s.build(title ?? ''), hint: s.hint }));
}
