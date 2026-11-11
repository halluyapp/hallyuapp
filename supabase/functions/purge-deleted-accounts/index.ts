// purge-deleted-accounts — retention enforcement.
//
// delete_account() leaves an anonymous tombstone so replies and posts never dangle. This function is
// the other half of that promise: after the retention window it hard-deletes the account, its posts,
// its comments and every storage object it uploaded.
//
// The objects go through the Storage API, because SQL is not allowed to delete them — see
// _shared/media-removal.ts. The order matters: the purge hard-deletes the profile rows that identify
// the paths, so the queue has to be written (by the SQL function) and drained afterwards, never
// recomputed from rows that no longer exist.
//
// Schedule it with pg_cron (see supabase/migrations/20260101122200_22_retention.sql) or run it by
// hand from the Supabase dashboard's function tester with the service-role bearer token.

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
  const retention = `${retentionDays} days`;

  // 1. Report what is about to go, so the run is auditable before it deletes anything.
  const { data: doomed, error: listError } = await supabase
    .from('profiles')
    .select('id, handle, deleted_at')
    .eq('account_status', 'deleted')
    .lt('deleted_at', new Date(Date.now() - retentionDays * 86_400_000).toISOString())
    .limit(500);

  if (listError) return errorResponse(`could not list deleted profiles: ${listError.message}`, 500);

  const ids = (doomed ?? []).map((p) => p.id as string);
  if (ids.length === 0) {
    // Nothing to purge, but an earlier run may have left objects queued — this is the run that
    // would have removed them, so it still drains the queue before reporting.
    const leftovers = await drainRemovalQueue();
    if (leftovers.error) return errorResponse(`storage queue retry failed: ${leftovers.error}`, 500);
    return jsonResponse({
      purged: 0,
      retention_days: retentionDays,
      profiles: [],
      storage_objects_queued: 0,
      storage_objects_removed: leftovers.removed,
      queue_remaining: leftovers.remaining,
    });
  }

  // 2. Audit the events that go with them (analytics rows are nulled on delete, so count first).
  const { count: eventCount, error: eventError } = await supabase
    .from('analytics_events')
    .select('id', { count: 'exact', head: true })
    .in('user_id', ids);

  if (eventError) return errorResponse(`could not size the deletion: ${eventError.message}`, 500);

  const { data: removed, error: purgeError } = await supabase.rpc('purge_deleted_accounts', {
    retention: retention,
  });

  if (purgeError) return errorResponse(`purge failed: ${purgeError.message}`, 500);

  const row = Array.isArray(removed) ? removed[0] : removed;
  if (typeof row?.profiles_purged !== 'number' || row.profiles_purged < 0) {
    return errorResponse('purge returned no verified profile count; inspect the run before retrying', 500);
  }

  // The purge only queued the paths; this is where the bytes actually go.
  const removals = await drainRemovalQueue();
  if (removals.error) {
    return errorResponse(`the accounts were purged but the Storage API refused a batch: ${removals.error}`, 500);
  }

  return jsonResponse({
    purged: row.profiles_purged,
    retention_days: retentionDays,
    profiles: (doomed ?? []).map((p) => ({ id: p.id, handle: p.handle, deleted_at: p.deleted_at })),
    storage_objects_queued: row?.storage_objects_queued ?? 0,
    storage_objects_removed: removals.removed,
    queue_remaining: removals.remaining,
    events_deleted_for_these_accounts: eventCount ?? 0,
  });
});