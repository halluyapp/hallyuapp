/**
 * Product analytics seam. Screens call `track(event, props)`; today it only buffers in memory
 * (and logs in dev), so a real sink (PostHog, Amplitude…) can be attached later without
 * touching call sites. Nothing personal is sent: ids are opaque, no free text.
 */
export type AnalyticsEvent =
  | 'app.open'
  | 'auth.signin'
  | 'auth.signup'
  | 'auth.guest'
  | 'onboarding.done'
  | 'post.publish'
  /** A media post finished the whole upload pipeline and was confirmed by post_media. */
  | 'post.publish.media'
  /** A media post failed partway; the draft was kept and the member was told which step. */
  | 'post.publish.failed'
  | 'post.delete'
  | 'comment.add'
  | 'reaction.set'
  | 'follow.set'
  | 'watch.set'
  | 'progress.set'
  | 'spoiler.reveal'
  | 'search.query'
  | 'catalog.import'
  | 'error.boundary'
  | 'error.async';

export interface AnalyticsSink {
  track(event: AnalyticsEvent, props?: Record<string, unknown>): void;
}

const buffer: { event: AnalyticsEvent; props?: Record<string, unknown>; at: number }[] = [];
let sink: AnalyticsSink | null = null;

export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
  if (sink) for (const b of buffer.splice(0)) sink.track(b.event, b.props);
}

export function track(event: AnalyticsEvent, props?: Record<string, unknown>): void {
  if (sink) return sink.track(event, props);
  buffer.push({ event, props, at: Date.now() });
  if (buffer.length > 200) buffer.shift();
  if (__DEV__ && event === 'error.boundary') console.warn('[analytics]', event, props);
}

/** For debugging / tests. */
export function drainAnalytics(): typeof buffer {
  return buffer.splice(0);
}

/**
 * Diagnostics for a caught async failure in a background component. Unlike a bare `catch {}`, this
 * always logs a useful line (dev) and forwards to the analytics sink, so a swallowed failure is
 * still observable. Never throws.
 */
function safeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .slice(0, 500);
}

export function reportError(scope: string, error: unknown, props?: Record<string, unknown>): void {
  const message = safeDiagnostic(error);
  // Do not print the original object: request errors can contain headers or refresh credentials.
  if (__DEV__) console.warn(`[hallyu:${scope}]`, message);
  try {
    track('error.async', { scope, message, ...props });
  } catch {
    /* analytics must never break the caller */
  }
}
