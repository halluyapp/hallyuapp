// media-cleanup — storage reconciliation.
//
// Calls `job_reconcile_media()`, which does the deciding in SQL: it drops `post_media` rows whose
// object no longer exists, *queues* `u/<id>/…` objects nothing references any more plus catalog
// artwork that has been unreferenced for longer than the refresh window, and purges the upload
// bookkeeping rows for all of it.
//
// SQL cannot delete a storage row — Supabase's `storage.protect_delete()` refuses it for every role
// — so the queue this run fills is drained here, through the Storage API, and the report says how
// many objects actually went away.
//
// Schedule it daily (see supabase/migrations/20260101123000_30_media_lifecycle.sql) or run it by
// hand from the dashboard with the service-role bearer token.
//
//   {"retention_days": 30}   how long unreferenced member uploads are kept

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { drainRemovalQueue } from '../_shared/media-removal.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';
import { integerOption, readObjectBody } from '../_shared/request.ts';

const DEFAULT_RETENTION_DAYS = 30;

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let retentionDays: number | null;
  try {
    const body = await readObjectBody(request);
    retentionDays = integerOption(body.retention_days, DEFAULT_RETENTION_DAYS, 1, 365);
  } catch {
    return errorResponse('a valid JSON object body is required', 400);
  }
  if (retentionDays === null) return errorResponse('retention_days must be an integer between 1 and 365', 400);

  const supabase = adminClient();

  // What is about to go, counted before anything is removed, so the run is auditable.
  const { count: pendingUploads, error: pendingError } = await supabase
    .from('media_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('state', 'pending');

  if (pendingError) return errorResponse(`could not size the cleanup: ${pendingError.message}`, 500);

  const { data, error } = await supabase.rpc('job_reconcile_media', {
    p_user_retention: `${retentionDays} days`,
  });

  if (error) return errorResponse(`cleanup failed: ${error.message}`, 500);

  const report = (data ?? {}) as Record<string, unknown>;

  // The bytes: whatever the SQL pass queued, plus anything a previous run could not remove.
  const removals = await drainRemovalQueue();
  if (removals.error) {
    return errorResponse(`the queue was drained but the Storage API refused a batch: ${removals.error}`, 500);
  }

  return jsonResponse({
    retention_days: retentionDays,
    pending_uploads_before: pendingUploads ?? 0,
    broken_rows_removed: report.broken_rows_removed ?? 0,
    orphan_objects_queued: report.orphan_objects_queued ?? 0,
    objects_removed: removals.removed,
    queue_remaining: removals.remaining,
    upload_rows_purged: report.upload_rows_purged ?? 0,
    pending_expired: report.pending_expired ?? 0,
    attached_uploads: report.attached ?? 0,
  });
});