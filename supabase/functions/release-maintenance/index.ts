import { verifyGitHubActionsToken } from '../_shared/githubActions.ts';
import { readObjectBody } from '../_shared/request.ts';
import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const BUCKET = 'app-releases';
const KEEP = 'hallyu-universal-latest.apk';
const MAX_OLD_APKS = 100;

/** Bounded complete listing; folder recursion is rejected because APK publication is flat. */
async function listApkNames(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
  const response = await fetch(`${baseUrl}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`release inventory failed (HTTP ${response.status})`);
  const entries = await response.json() as { name?: string; id?: string | null }[];
  if (!Array.isArray(entries) || entries.length >= 1000) throw new Error('release inventory is incomplete');
  return entries.filter((entry) => typeof entry.id === 'string' && typeof entry.name === 'string' && entry.name.toLowerCase().endsWith('.apk')).map((entry) => entry.name!);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  try {
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const repository = Deno.env.get('GITHUB_RELEASE_REPOSITORY') ?? 'halluyapp/hallyuapp';
    await verifyGitHubActionsToken(token, repository);
    const body = await readObjectBody(request, false);
    if (body.expected_apk !== KEEP) return jsonResponse({ error: 'only the stable universal APK can be retained' }, 400);
    const baseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!baseUrl || !serviceKey) return jsonResponse({ error: 'release maintenance is not configured' }, 503);

    // Check existence through the public object endpoint; never infer success from a caller claim.
    const current = await fetch(`${baseUrl}/storage/v1/object/public/${BUCKET}/${KEEP}`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    if (!current.ok) return jsonResponse({ error: 'new universal APK is not public; nothing was deleted' }, 409);
    const names = await listApkNames(baseUrl, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });
    if (!names.includes(KEEP)) return jsonResponse({ error: 'stable APK is absent from inventory; nothing was deleted' }, 409);
    const obsolete = names.filter((name) => name !== KEEP);
    if (obsolete.length > MAX_OLD_APKS) return jsonResponse({ error: 'too many obsolete APKs; manual review required' }, 409);
    if (obsolete.length) {
      const { error } = await adminClient().storage.from(BUCKET).remove(obsolete);
      if (error) return jsonResponse({ error: 'old APK deletion failed', detail: error.message }, 502);
    }
    const remaining = (await listApkNames(baseUrl, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` })).filter((name) => name !== KEEP);
    if (remaining.length) return jsonResponse({ error: 'old APKs remain after cleanup' }, 502);
    return jsonResponse({ retained: KEEP, deleted: obsolete.length });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'release maintenance failed' }, 401);
  }
});
