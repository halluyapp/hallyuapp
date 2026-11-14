// catalog-jobs — the scheduler's entry point. SQL owns run keys, claims, outcomes, and retries.
// POST with a service-role bearer. An empty body runs the default list; {"jobs":["catalog.status"]}
// runs a bounded explicit list. Concurrent/repeated ticks are settled by job_claim(), not here.

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';
import { readObjectBody } from '../_shared/request.ts';

interface JobOutcome {
  job: string;
  status: string;
  run_id: string;
  items: number;
  error: string | null;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);
  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await readObjectBody(request);
  } catch {
    return errorResponse('a valid JSON object body is required', 400);
  }
  const jobs = body.jobs;
  if (
    jobs !== undefined &&
    (!Array.isArray(jobs) || jobs.length > 20 || !jobs.every((job) => typeof job === 'string' && /^[a-z][a-z0-9_.-]{1,80}$/.test(job)))
  ) {
    return errorResponse('jobs must be an array of at most 20 valid job names', 400);
  }

  const supabase = adminClient();
  const { data, error } = await supabase.rpc('run_scheduled_jobs', { p_jobs: jobs ?? null });
  if (error) return errorResponse(`could not run the scheduled jobs: ${error.message}`, 500);

  const outcomes = (data ?? []) as JobOutcome[];
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  return jsonResponse({
    ran: outcomes.length,
    failed: failures.length,
    jobs: outcomes.map((outcome) => ({
      job: outcome.job,
      status: outcome.status,
      run_id: outcome.run_id,
      items: outcome.items,
      ...(outcome.error ? { error: outcome.error } : {}),
    })),
    ran_at: new Date().toISOString(),
  }, failures.length > 0 ? 207 : 200);
});
