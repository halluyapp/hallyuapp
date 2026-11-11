// Draining the media removal queue through the Storage API.
//
// Supabase installs `storage.protect_delete()`, which refuses `DELETE` on `storage.objects` for
// every role — "Direct deletion from storage tables is not allowed. Use the Storage API instead."
// So the division of labour is: SQL decides *what* disappears and writes the path to
// `public.media_removal_queue`; this module is the only thing that may actually remove it.
//
// It is shared by both callers that produce deletions — media-cleanup (orphans and stale catalog
// artwork) and purge-deleted-accounts (a member's uploads after the retention window) — so the
// claim/complete bookkeeping, the batch size and the error handling cannot drift apart.

import { adminClient } from './supabase.ts';

const BUCKET = 'media';
const DEFAULT_BATCH = 100;

export interface RemovalResult {
  /** Objects the Storage API confirmed are gone. */
  removed: number;
  /** Objects that are still queued because the Storage API refused them. */
  remaining: number;
  /** The first refusal, if there was one — reported so a run is never silently partial. */
  error: string | null;
}

/**
 * Claims a batch from the queue, removes each path through the Storage API, and settles the queue
 * rows: gone objects are deleted from the queue, refused ones keep their row and record the error so
 * the next run retries them instead of losing them.
 */
export async function drainRemovalQueue(limit: number = DEFAULT_BATCH): Promise<RemovalResult> {
  const supabase = adminClient();

  const { data: claimed, error: claimError } = await supabase.rpc('claim_media_removals', {
    p_limit: limit,
  });

  if (claimError) return { removed: 0, remaining: 0, error: `claim failed: ${claimError.message}` };

  const rows = (claimed ?? []) as { path: string; reason: string; attempts: number }[];
  if (rows.length === 0) return { removed: 0, remaining: 0, error: null };

  const gone: string[] = [];
  const stuck: string[] = [];
  let firstError: string | null = null;

  // One call per batch rather than one per object: the Storage API accepts an array of paths, and a
  // queue of a few hundred objects should not become a few hundred round trips.
  const { error: removeError } = await supabase.storage.from(BUCKET).remove(rows.map((row) => row.path));

  if (removeError) {
    // The whole batch failed. Nothing is settled: the paths stay queued with the reason attached.
    stuck.push(...rows.map((row) => row.path));
    firstError = removeError.message;
  } else {
    gone.push(...rows.map((row) => row.path));
  }

  if (stuck.length > 0) {
    const { error } = await supabase.rpc('complete_media_removals', { p_paths: stuck, p_error: firstError });
    if (error) firstError = `could not record refused removals: ${error.message}`;
  }
  if (gone.length > 0) {
    const { error } = await supabase.rpc('complete_media_removals', { p_paths: gone, p_error: null });
    // Storage already confirmed removal, but the queue must not be reported as reconciled when its
    // bookkeeping failed. A later run may safely repeat the idempotent Storage delete.
    if (error) firstError = `objects were removed but queue completion failed: ${error.message}`;
  }

  const { count, error: countError } = await supabase
    .from('media_removal_queue')
    .select('path', { count: 'exact', head: true });
  if (countError) firstError = `could not count remaining removals: ${countError.message}`;

  return { removed: gone.length, remaining: count ?? stuck.length, error: firstError };
}