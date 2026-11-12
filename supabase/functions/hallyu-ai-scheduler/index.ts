// Scheduled AI dispatcher. Publicly reachable without a Supabase JWT only because it performs full
// GitHub OIDC signature/audience/repository/workflow/ref verification. No credential is shipped to
// GitHub; the service-role bearer remains inside this function and the protected operator.
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { verifyGitHubSchedulerToken } from '../_shared/githubScheduler.ts';

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  try {
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const repository = Deno.env.get('GITHUB_RELEASE_REPOSITORY') ?? 'halluyapp/hallyuapp';
    const identity = await verifyGitHubSchedulerToken(token, repository);
    const baseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!baseUrl || !serviceKey) return jsonResponse({ error: 'scheduler backend is not configured' }, 503);
    const response = await fetch(`${baseUrl}/functions/v1/hallyu-ai-operator`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule.run_due' }),
    });
    const result = await response.text();
    // Preserve the operator's real status/body; never convert a failed run into scheduler success.
    return new Response(result, { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Hallyu-Scheduler-Run': identity.runId } });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'scheduler authorization failed' }, 401);
  }
});
