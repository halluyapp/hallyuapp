// hallyu-ai-scheduler — background intelligence scheduler.
//
// Triggered by pg_cron, pg_net, or admin manual trigger with a service-role bearer.
// Scans `hallyu_ai_schedule` for enabled tasks due to run, creates tasks in `hallyu_ai_task`,
// updates `last_run_at` and `last_status`.

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';
import { readObjectBody } from '../_shared/request.ts';

interface ScheduleRow {
  id: string;
  name: string;
  kind: string;
  interval_minutes: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_run_at: string | null;
  last_status: string | null;
}

interface RunOutcome {
  schedule_id: string;
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  task_id?: string;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> = {};
  try {
    body = await readObjectBody(request);
  } catch {
    // Empty body is valid: runs all due enabled schedules
  }

  const supabase = adminClient();
  const scheduleId = typeof body.schedule_id === 'string' ? body.schedule_id : null;
  const force = Boolean(body.force);

  let query = supabase.from('hallyu_ai_schedule').select('*');
  if (scheduleId) {
    query = query.eq('id', scheduleId);
  } else if (!force) {
    query = query.eq('enabled', true);
  }

  const { data, error } = await query;
  if (error) return errorResponse(`could not load schedules: ${error.message}`, 500);

  const schedules = (data ?? []) as ScheduleRow[];
  const outcomes: RunOutcome[] = [];
  const now = Date.now();

  for (const schedule of schedules) {
    if (!force && schedule.last_run_at) {
      const lastRun = new Date(schedule.last_run_at).getTime();
      const elapsedMinutes = (now - lastRun) / (1000 * 60);
      if (elapsedMinutes < schedule.interval_minutes) {
        outcomes.push({
          schedule_id: schedule.id,
          name: schedule.name,
          status: 'skipped',
          detail: `not due yet (${Math.round(schedule.interval_minutes - elapsedMinutes)}m remaining)`,
        });
        continue;
      }
    }

    try {
      let prompt = '';
      if (schedule.kind === 'daily_intelligence') {
        prompt = 'Run daily platform intelligence: check platform_overview, community_pulse, and summarize key community trends, engagement, and operational anomalies.';
      } else if (schedule.kind === 'community_pulse') {
        prompt = 'Run community pulse watch: inspect recent public posts and comments for emerging fan discussions, sentiment shifts, or community questions.';
      } else if (schedule.kind === 'entertainment_intelligence') {
        prompt = 'Review entertainment watchlist and catalog sync status for K-drama and C-drama releases; note any sync failures or missing titles.';
      } else {
        prompt = `Execute automated task for schedule: ${schedule.name}`;
      }

      // Create task in hallyu_ai_task via PostgREST
      const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const res = await fetch(`${supabaseUrl}/rest/v1/hallyu_ai_task`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          kind: 'ops',
          title: `Scheduled: ${schedule.name}`,
          prompt,
          requester_role: 'admin',
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`failed to create task: HTTP ${res.status} ${text.slice(0, 100)}`);
      }

      const rows = (await res.json().catch(() => [])) as { id: string }[];
      const taskId = rows[0]?.id;

      await supabase.from('hallyu_ai_schedule').update({
        last_run_at: new Date().toISOString(),
        last_status: 'ok',
      }).eq('id', schedule.id);

      outcomes.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status: 'ok',
        task_id: taskId,
        detail: 'scheduled run queued successfully',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from('hallyu_ai_schedule').update({
        last_run_at: new Date().toISOString(),
        last_status: `failed: ${msg.slice(0, 100)}`,
      }).eq('id', schedule.id);

      outcomes.push({
        schedule_id: schedule.id,
        name: schedule.name,
        status: 'failed',
        detail: msg,
      });
    }
  }

  const failures = outcomes.filter((o) => o.status === 'failed');
  return jsonResponse({
    ran: outcomes.length,
    failed: failures.length,
    outcomes,
    ran_at: new Date().toISOString(),
  }, failures.length > 0 ? 207 : 200);
});
