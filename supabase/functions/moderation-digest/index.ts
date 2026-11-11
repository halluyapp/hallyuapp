// moderation-digest — atomically claims open reports, groups them by target, and returns the digest.
// SQL releases stale reviewing rows and uses FOR UPDATE SKIP LOCKED, so concurrent workers cannot
// surface the same open report. Service-role only; no member report data is exposed by this endpoint.

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';

const STALE_REVIEWING_HOURS = 48;

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: string;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);
  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  const supabase = adminClient();
  const staleCutoff = new Date(Date.now() - STALE_REVIEWING_HOURS * 3_600_000).toISOString();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_moderation_reports', {
    p_limit: 200,
    p_stale_before: staleCutoff,
  });
  if (claimError) return errorResponse(`could not claim reports: ${claimError.message}`, 500);
  const reports = (claimed ?? []) as ReportRow[];

  const grouped = new Map<string, { target_type: string; target_id: string; reports: ReportRow[]; oldest: string }>();
  for (const report of reports) {
    const key = `${report.target_type}:${report.target_id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.reports.push(report);
    } else {
      grouped.set(key, {
        target_type: report.target_type,
        target_id: report.target_id,
        reports: [report],
        oldest: report.created_at,
      });
    }
  }

  const digest = [...grouped.values()]
    .map((group) => ({
      target_type: group.target_type,
      target_id: group.target_id,
      report_count: group.reports.length,
      distinct_reporters: new Set(group.reports.map((report) => report.reporter_id)).size,
      reasons: [...new Set(group.reports.map((report) => report.reason))],
      oldest_report_at: group.oldest,
      report_ids: group.reports.map((report) => report.id),
    }))
    .sort((a, b) => b.distinct_reporters - a.distinct_reporters || a.oldest_report_at.localeCompare(b.oldest_report_at));

  return jsonResponse({
    claimed_reports: reports.length,
    unique_targets: digest.length,
    digest,
    released_stale_before: staleCutoff,
  });
});
