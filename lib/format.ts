import * as Crypto from 'expo-crypto';

/** "now" for the app (one seam so tests and screens agree). */
export function now(): Date {
  return new Date();
}

export function timeAgo(isoDate: string, from: Date = now()): string {
  const diff = Math.max(0, from.getTime() - new Date(isoDate).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  const date = new Date(isoDate);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== from.getFullYear() ? 'numeric' : undefined });
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Byte count as a person reads it, for upload and quota copy: "45.2 MB", "1.1 GB". */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function shortDate(iso?: string): string {
  if (!iso) return 'TBA';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dayLabel(iso: string, from: Date = now()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(from)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function countdown(iso: string, from: Date = now()): string {
  const diff = new Date(iso).getTime() - from.getTime();
  if (diff <= 0) return 'now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

export function runtimeLabel(min?: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m}m`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${compact(n)} ${n === 1 ? one : many}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function seasonEpisodeLabel(season?: number, episode?: number, seasonCount = 1): string {
  if (!episode) return season && seasonCount > 1 ? `Season ${season}` : '';
  return seasonCount > 1 ? `S${season ?? 1} · Ep ${episode}` : `Ep ${episode}`;
}

/**
 * Client-generated ids are real UUIDs: stable, collision-proof keys for locally created content.
 * The prefix is kept only for call-site readability; it is not part of the id.
 */
export function uid(_prefix = 'id'): string {
  try {
    return Crypto.randomUUID();
  } catch {
    // very old web runtimes without crypto.getRandomValues
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

export function extractHashtags(text: string): string[] {
  return [...new Set((text.match(/#([\p{L}\p{N}_]+)/gu) ?? []).map((t) => t.slice(1)))];
}

export function extractMentions(text: string): string[] {
  return [...new Set((text.match(/@([a-z0-9_.]+)/gi) ?? []).map((t) => t.slice(1).toLowerCase()))];
}
