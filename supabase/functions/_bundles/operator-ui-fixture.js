// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/operator-ui-fixture/index.ts (plus its imports from supabase/functions/_shared).
// Regenerate with: node scripts/build-operator-bundles.mjs
// supabase/functions/_shared/githubActions.ts
function decodeJsonPart(value, label) {
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`invalid GitHub OIDC ${label}`);
  }
}
async function jwks(issuer) {
  const response = await fetch(`${issuer}/.well-known/jwks`, { signal: AbortSignal.timeout(1e4) });
  if (!response.ok) throw new Error("GitHub OIDC key service is unavailable");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("GitHub OIDC returned no keys");
  return body.keys;
}
async function verifyGitHubActionsToken(token, repository, scope) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || token.split(".").length !== 3) throw new Error("invalid GitHub OIDC token");
  const header = decodeJsonPart(encodedHeader, "header");
  const payload = decodeJsonPart(encodedPayload, "payload");
  const issuer = "https://token.actions.githubusercontent.com";
  const audience = scope?.audience ?? Deno.env.get("GITHUB_ACTIONS_OIDC_AUDIENCE") ?? "hallyu-release-maintenance";
  const requiredRef = scope?.ref ?? Deno.env.get("GITHUB_RELEASE_REF");
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("invalid GitHub OIDC algorithm");
  if (payload.iss !== issuer || payload.repository !== repository || !["push", "workflow_dispatch"].includes(String(payload.event_name))) {
    throw new Error("GitHub OIDC issuer, repository, or event is not authorized");
  }
  if (typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/") || requiredRef && payload.ref !== requiredRef) {
    throw new Error("GitHub OIDC branch is not authorized for release maintenance");
  }
  if (scope && (String(payload.repository_id) !== scope.repositoryId || payload.event_name !== "workflow_dispatch" || !/^\d+$/.test(String(payload.run_id)) || !/^\d+$/.test(String(payload.run_attempt)))) {
    throw new Error("GitHub OIDC fixture run is not authorized");
  }
  const workflow = scope ? payload.workflow_ref : payload.job_workflow_ref;
  const expectedWorkflow = scope ? `${repository}/.github/workflows/${scope.workflowFile}@${payload.ref}` : `${repository}/.github/workflows/build-apk.yml@${payload.ref}`;
  if (workflow !== expectedWorkflow) {
    throw new Error("GitHub OIDC workflow is not the APK publisher");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw new Error("invalid GitHub OIDC audience");
  const now = Math.floor(Date.now() / 1e3);
  if (typeof payload.exp !== "number" || typeof payload.nbf !== "number" || payload.exp <= now || payload.nbf > now + 60) {
    throw new Error("GitHub OIDC token is expired or not yet valid");
  }
  const key = (await jwks(issuer)).find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!key) throw new Error("GitHub OIDC signing key was not found");
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  if (!valid) throw new Error("invalid GitHub OIDC signature");
  return { repository, ref: payload.ref, workflow: String(workflow), runId: String(payload.run_id ?? ""), runAttempt: String(payload.run_attempt ?? "") };
}

// supabase/functions/_shared/cors.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// supabase/functions/operator-ui-fixture/index.ts
var base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
var service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
async function api(path, method = "GET", body) {
  const response = await fetch(base + path, { method, headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: body === void 0 ? void 0 : JSON.stringify(body), signal: AbortSignal.timeout(2e4) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`fixture_backend_${response.status}:${String(result?.code ?? result?.error_code ?? "request_failed")}`);
  return result;
}
async function runs(identity) {
  return await api(`/rest/v1/operator_acceptance_run?select=id,fixture_user_ids,report,state&report->>kind=eq.ui_fixture&report->>github_run_id=eq.${identity.runId}&report->>github_attempt=eq.${identity.runAttempt}`);
}
async function fixtureProfile(run) {
  const user = run.fixture_user_ids?.[0];
  if (!user || run.fixture_user_ids.length !== 1) throw new Error("fixture_user_missing");
  const auth = await api(`/auth/v1/admin/users/${user}`);
  if (auth?.user_metadata?.nari_ui_fixture !== run.id) throw new Error("fixture_identity_mismatch");
  return (await api(`/rest/v1/profiles?select=id,role&auth_sub=eq.${user}`))[0] ?? null;
}
async function cleanup(run) {
  for (const user of run.fixture_user_ids ?? []) {
    const auth = await api(`/auth/v1/admin/users/${user}`).catch((error) => {
      if (String(error).includes("fixture_backend_404")) return null;
      throw error;
    });
    if (!auth) continue;
    if (auth.user_metadata?.nari_ui_fixture !== run.id) throw new Error("fixture_cleanup_identity_mismatch");
    const profiles = await api(`/rest/v1/profiles?select=id&auth_sub=eq.${user}`);
    for (const profile of profiles) {
      await api(`/rest/v1/operator_memory?scope=eq.member&scope_id=eq.${profile.id}`, "DELETE");
      await api(`/rest/v1/profiles?id=eq.${profile.id}`, "DELETE");
    }
    await api(`/auth/v1/admin/users/${user}`, "DELETE");
  }
  if (run.report?.slug === `nari-ui-${run.id}`) await api(`/rest/v1/operator_knowledge?slug=eq.${run.report.slug}`, "DELETE");
  await api(`/rest/v1/operator_acceptance_run?id=eq.${run.id}`, "PATCH", { state: "finished", finished_at: (/* @__PURE__ */ new Date()).toISOString(), report: { ...run.report, cleanup: "pass" } });
}
Deno.serve(async (request) => {
  if (request.method !== "POST") return errorResponse("POST only", 405);
  let identity;
  try {
    const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token || token.length > 2e4) return errorResponse("GitHub OIDC required", 401);
    identity = await verifyGitHubActionsToken(token, "halluyapp/hallyuapp", {
      audience: "hallyu-nari-ui",
      workflowFile: "deploy-web.yml",
      ref: "refs/heads/arena/3e7f1083-hallyuapp",
      repositoryId: "1374619123"
    });
  } catch {
    return errorResponse("GitHub workflow identity not authorized", 403);
  }
  try {
    const body = await request.json();
    const action = body?.action;
    if (!["create", "inspect", "promote", "cleanup"].includes(action)) return errorResponse("unsupported fixture action", 400);
    const current = await runs(identity);
    if (action === "cleanup") {
      for (const run2 of current) await cleanup(run2);
      return jsonResponse({ ok: true, cleaned: current.length });
    }
    if (action === "create") {
      if (current.length) return errorResponse("fixture already reserved for this workflow attempt", 409);
      const id = crypto.randomUUID();
      const report = { kind: "ui_fixture", github_run_id: identity.runId, github_attempt: identity.runAttempt, slug: `nari-ui-${id}`, expires_at: new Date(Date.now() + 20 * 6e4).toISOString() };
      await api("/rest/v1/operator_acceptance_run", "POST", { id, state: "running", report });
      const email = `nari.ui.${id}@example.invalid`;
      const password = crypto.randomUUID() + "Aa7!";
      let user;
      try {
        user = await api("/auth/v1/admin/users", "POST", { email, password, email_confirm: true, user_metadata: { full_name: "Nari UI Acceptance", nari_ui_fixture: id } });
        await api(`/rest/v1/operator_acceptance_run?id=eq.${id}`, "PATCH", { fixture_user_ids: [user.id] });
      } catch (error) {
        if (user?.id) await api(`/auth/v1/admin/users/${user.id}`, "DELETE");
        await api(`/rest/v1/operator_acceptance_run?id=eq.${id}`, "PATCH", { state: "failed", finished_at: (/* @__PURE__ */ new Date()).toISOString() });
        throw error;
      }
      return new Response(JSON.stringify({ email, password, slug: report.slug }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (current.length !== 1 || current[0].state !== "running") return errorResponse("active fixture not found", 404);
    const run = current[0];
    if (Date.parse(run.report.expires_at) < Date.now()) {
      await cleanup(run);
      return errorResponse("fixture expired", 410);
    }
    const profile = await fixtureProfile(run);
    if (!profile) return errorResponse("fixture profile not provisioned", 409);
    if (action === "promote") {
      await api(`/rest/v1/profiles?id=eq.${profile.id}`, "PATCH", { role: "admin" });
      await api("/rest/v1/rpc/operator_audit_write", "POST", { p_action: "acceptance.fixture_promote", p_outcome: "succeeded", p_actor_type: "system", p_resource_type: "profile", p_resource_id: profile.id, p_details: { github_run_id: identity.runId } });
      return jsonResponse({ ok: true });
    }
    const memory = await api(`/rest/v1/operator_memory?select=key&scope=eq.member&scope_id=eq.${profile.id}`);
    return jsonResponse({ profile_id: profile.id, role: profile.role, memory_count: memory.length });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "fixture_failed", 500);
  }
});
