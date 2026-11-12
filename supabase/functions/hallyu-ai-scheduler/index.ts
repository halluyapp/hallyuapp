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
    const body = await request.json().catch(() => ({})) as { action?: string };
    const identity = await verifyGitHubSchedulerToken(token, repository, body.action === 'model.validate' ? 'backend-verification.yml' : 'hallyu-ai-scheduler.yml');
    if (body.action === 'model.validate') {
      const toolkitUrl = (Deno.env.get('TOOLKIT_URL') ?? Deno.env.get('EXPO_PUBLIC_TOOLKIT_URL') ?? 'https://toolkit.rork.com').replace(/\/$/, '');
      const toolkitKey = Deno.env.get('RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('RORK_AI_API_KEY') ?? '';
      const model = Deno.env.get('RORK_AI_MODEL') ?? 'anthropic/claude-sonnet-5';
      if (!toolkitKey) return jsonResponse({ error: 'Rork AI credential is not configured' }, 503);
      const validation = await fetch(`${toolkitUrl}/v2/vercel/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(35_000),
        headers: { Authorization: `Bearer ${toolkitKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 80, messages: [
          { role: 'system', content: 'Return only the requested health-check phrase.' },
          { role: 'user', content: 'Reply with exactly: HALLYU_RORK_MODEL_OK' },
        ] }),
      });
      if (!validation.ok) return jsonResponse({ error: `Rork model validation failed (HTTP ${validation.status}): ${(await validation.text()).slice(0, 240)}` }, 502);
      const result = await validation.json() as { choices?: { message?: { content?: unknown } }[] };
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return jsonResponse({ error: 'Rork returned an empty or unsupported response' }, 502);
      return jsonResponse({ status: 'completed', model, response: content.trim().slice(0, 200), schedules_ran: false });
    }
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
