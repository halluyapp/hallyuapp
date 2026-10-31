/**
 * Watch timing marks. Every Watch network step records one span, so the load times in the release
 * report are readings taken on a real device rather than estimates. Bounded ring buffer, no I/O, and
 * nothing leaves the device.
 */

export interface WatchPerfSpan {
  label: string;
  ms: number;
  at: number;
}

const MAX_SPANS = 40;
const pending = new Map<string, number>();
let spans: WatchPerfSpan[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of Array.from(listeners)) fn();
}

/** Starts (or restarts) a span. */
export function beginWatch(label: string): void {
  pending.set(label, Date.now());
}

/** Ends a span and keeps it. Returns the elapsed milliseconds, or null when the label was not started. */
export function endWatch(label: string): number | null {
  const started = pending.get(label);
  if (started === undefined) return null;
  pending.delete(label);
  const ms = Date.now() - started;
  spans = [{ label, ms, at: Date.now() }, ...spans].slice(0, MAX_SPANS);
  notify();
  return ms;
}

/** Records a span measured elsewhere (for example around a render-to-first-frame). */
export function recordWatch(label: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  spans = [{ label, ms, at: Date.now() }, ...spans].slice(0, MAX_SPANS);
  notify();
}

/** Times an async step and always ends the span, success or failure. */
export async function timeWatch<T>(label: string, run: () => Promise<T>): Promise<T> {
  beginWatch(label);
  try {
    return await run();
  } finally {
    endWatch(label);
  }
}

export function watchPerfSnapshot(): WatchPerfSpan[] {
  return spans;
}

export function subscribeWatchPerf(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** One-line-per-span summary, suitable for a screenshot or a support ticket. */
export function watchPerfSummary(): string {
  if (spans.length === 0) return 'No Watch timings recorded yet.';
  return spans
    .slice(0, 8)
    .map((s) => `${s.label}: ${s.ms}ms`)
    .join('\n');
}
