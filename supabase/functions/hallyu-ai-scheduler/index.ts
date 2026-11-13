// hallyu-ai-scheduler — the bridge that lets the operator run 24/7.
//
// Two kinds of caller are accepted, and nothing else:
//
//   1. A GitHub Actions job (.github/workflows/hallyu-ai-scheduler.yml). GitHub mints a short-lived
//      OIDC token for that exact job; we verify its RS256 signature against GitHub's published keys
//      and require that the token was issued for THIS workflow in THIS repository with our audience.
//      No long-lived secret is stored in the repository.
//   2. A service-role bearer, which is how an admin or the platform triggers a tick by hand.
//
// The caller is only ever allowed to ask for a tick. The function then calls `hallyu-ai-operator`
// with its own service credential and `action: "schedule.run_due"`, so all real work (claiming due
// schedules, running tasks, publishing, notifying the owner) stays inside the operator, where the
// model, tools and publication ledger already live. This function never publishes anything itself.

// Self-contained on purpose: this function is deployed as a single file, so it cannot rely on a
// sibling module resolving at bundle time. The policy matches supabase/functions/_shared/cors.ts.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const errorResponse = (message: string, status = 400): Response => jsonResponse({ error: message }, status);

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const AUDIENCE = Deno.env.get('SCHEDULER_AUDIENCE') ?? 'hallyu-ai-scheduler';
const REPOSITORY = Deno.env.get('SCHEDULER_REPOSITORY') ?? 'halluyapp/hallyuapp';
const WORKFLOW_PATH = '.github/workflows/hallyu-ai-scheduler.yml';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`;

interface OidcClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  repository?: string;
  job_workflow_ref?: string;
  event_name?: string;
}

const b64urlToBytes = (input: string): Uint8Array => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const decodeJson = <T>(part: string): T => JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;

/**
 * Is this token a service credential? PostgREST decides: only service_role may execute
 * `hallyu_ai_profile_id`, so a member key or anon key is rejected by the database itself. This also
 * covers the API-key style credentials that are not JWTs at all.
 */
async function isServiceCredential(token: string): Promise<boolean> {
  if (!token) return false;
  if (token === SERVICE_ROLE_KEY) return true;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hallyu_ai_profile_id`, {
    method: 'POST',
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
  }).catch(() => null);
  if (!res?.ok) return false;
  const id = (await res.json().catch(() => null)) as string | null;
  return typeof id === 'string' && id.length > 0;
}

/** Verify a GitHub Actions OIDC token against GitHub's published JWKS and the claims we require. */
async function verifyGithubOidc(token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a jwt' };

  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = decodeJson<{ alg?: string; kid?: string }>(parts[0]!);
    claims = decodeJson<OidcClaims>(parts[1]!);
  } catch {
    return { ok: false, reason: 'unreadable jwt' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'unsupported jwt header' };

  const jwksRes = await fetch(GITHUB_JWKS).catch(() => null);
  if (!jwksRes?.ok) return { ok: false, reason: 'github keys unavailable' };
  const jwks = (await jwksRes.json().catch(() => null)) as { keys?: { kid?: string; n?: string; e?: string }[] } | null;
  const jwk = jwks?.keys?.find((key) => key.kid === header.kid);
  if (!jwk?.n || !jwk?.e) return { ok: false, reason: 'signing key not found' };

  const key = await crypto.subtle
    .importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    .catch(() => null);
  if (!key) return { ok: false, reason: 'signing key unusable' };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle
    .verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]!), signed)
    .catch(() => false);
  if (!valid) return { ok: false, reason: 'bad signature' };

  if (claims.iss !== GITHUB_ISSUER) return { ok: false, reason: 'wrong issuer' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(AUDIENCE)) return { ok: false, reason: 'wrong audience' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return { ok: false, reason: 'expired' };
  if (claims.repository !== REPOSITORY) return { ok: false, reason: 'wrong repository' };
  const workflowRef = claims.job_workflow_ref ?? '';
  if (!workflowRef.startsWith(`${REPOSITORY}/${WORKFLOW_PATH}@`)) return { ok: false, reason: 'wrong workflow' };

  return { ok: true };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);

  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return errorResponse('authorization required', 401);
  if (!SERVICE_ROLE_KEY || !SUPABASE_URL) return errorResponse('scheduler is missing its backend credentials', 503);

  const isServiceRole = await isServiceCredential(token);
  if (!isServiceRole) {
    const check = await verifyGithubOidc(token);
    if (!check.ok) return errorResponse(`not an authorised scheduler caller: ${check.reason}`, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // An empty body is valid: it means "run whatever is due".
  }
  const limit = Math.min(Math.max(Number(body.limit) || 3, 1), 5);

  const askOperator = async (action: string) => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/hallyu-ai-operator`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ action, limit }),
    }).catch(() => null);
    if (!res) return { ok: false as const, status: 0, payload: 'the operator did not answer' };
    const text = await res.text().catch(() => '');
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // Keep the raw text so a broken operator response is visible instead of swallowed.
    }
    return { ok: res.ok, status: res.status, payload };
  };

  // Talking to members comes first: a waiting DM or mention matters more than the next article.
  const events = await askOperator('event.process');
  const schedules = await askOperator('schedule.run_due');

  const failed = [events, schedules].filter((call) => !call.ok);
  const body_ = {
    triggered_by: isServiceRole ? 'service_role' : 'github_oidc',
    events: events.payload,
    schedules: schedules.payload,
    ran_at: new Date().toISOString(),
  };

  if (failed.length > 0) return jsonResponse({ ...body_, failed_calls: failed.length }, failed[0]!.status || 502);
  return jsonResponse(body_, 200);
});
