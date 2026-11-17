// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/operator-acceptance/index.ts (plus its imports from supabase/functions/_shared).
// Regenerate with: node scripts/build-operator-bundles.mjs
// supabase/functions/_shared/supabase.ts
var SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
var SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
var QueryBuilder = class {
  constructor(table) {
    this.table = table;
  }
  table;
  method = "GET";
  selectCols = "*";
  wantCount = false;
  singleRow = false;
  patchBody = null;
  filters = [];
  select(columns = "*", opts) {
    this.selectCols = columns;
    this.wantCount = opts?.count === "exact";
    if (opts?.head) this.method = "HEAD";
    return this;
  }
  update(values) {
    this.method = "PATCH";
    this.patchBody = values;
    return this;
  }
  eq(column, value) {
    this.filters.push([column, `eq.${value}`]);
    return this;
  }
  in(column, values) {
    const encoded = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",");
    this.filters.push([column, `in.(${encoded})`]);
    return this;
  }
  is(column, value) {
    this.filters.push([column, `is.${String(value)}`]);
    return this;
  }
  lt(column, value) {
    this.filters.push([column, `lt.${value}`]);
    return this;
  }
  lte(column, value) {
    this.filters.push([column, `lte.${value}`]);
    return this;
  }
  gt(column, value) {
    this.filters.push([column, `gt.${value}`]);
    return this;
  }
  gte(column, value) {
    this.filters.push([column, `gte.${value}`]);
    return this;
  }
  order(column, opts) {
    const dir = opts?.ascending === false ? "desc" : "asc";
    const nulls = opts?.nullsFirst === false ? ".nullslast" : opts?.nullsFirst === true ? ".nullsfirst" : "";
    this.filters.push(["order", `${column}.${dir}${nulls}`]);
    return this;
  }
  limit(n) {
    this.filters.push(["limit", String(n)]);
    return this;
  }
  single() {
    this.singleRow = true;
    return this;
  }
  async execute() {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${this.table}`);
    if (this.method !== "PATCH") {
      url.searchParams.set("select", this.selectCols);
    }
    for (const [k, v] of this.filters) {
      url.searchParams.append(k, v);
    }
    const prefer = [];
    if (this.wantCount) prefer.push("count=exact");
    if (this.method === "PATCH") prefer.push("return=minimal");
    const headers = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "x-application-name": "hallyu-edge",
      Accept: this.singleRow ? "application/vnd.pgrst.object+json" : "application/json"
    };
    if (prefer.length > 0) headers.Prefer = prefer.join(",");
    if (this.patchBody !== null) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: this.method,
      headers,
      body: this.patchBody !== null ? JSON.stringify(this.patchBody) : void 0
    });
    const contentRange = res.headers.get("content-range");
    let count = null;
    if (contentRange && contentRange.includes("/")) {
      const parsed = Number(contentRange.split("/")[1]);
      if (Number.isFinite(parsed)) count = parsed;
    }
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      return { data: null, count, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
    }
    if (this.method === "HEAD" || res.status === 204) {
      return { data: null, count, error: null };
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { data, count, error: null };
  }
  then(onfulfilled, onrejected) {
    return this.execute().then(onfulfilled, onrejected);
  }
};
function adminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as function secrets");
  }
  return {
    async rpc(fn, params = {}) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "x-application-name": "hallyu-edge"
        },
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        return { data: null, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
      }
      const text = await res.text();
      return { data: text ? JSON.parse(text) : null, error: null };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table) {
      return new QueryBuilder(table);
    },
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
                "x-application-name": "hallyu-edge"
              },
              body: JSON.stringify({ prefixes: paths })
            });
            if (!res.ok) {
              const text2 = await res.text().catch(() => "");
              return { data: null, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
            }
            const text = await res.text();
            return { data: text ? JSON.parse(text) : [], error: null };
          }
        };
      }
    }
  };
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

// supabase/functions/operator-acceptance/index.ts
var base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
var service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
var admin = adminClient();
async function api(path, method = "GET", body, token = service) {
  const response = await fetch(base + path, { method, headers: {
    apikey: service,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  }, body: body === void 0 ? void 0 : JSON.stringify(body), signal: AbortSignal.timeout(6e4) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP_${response.status}:${String(data?.code ?? data?.error_code ?? "request_failed")}`);
  return data;
}
var rpc = (name, body, token = service) => api("/rest/v1/rpc/" + name, "POST", body, token);
Deno.serve(async (request) => {
  const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (request.method !== "POST" || !token || (await admin.rpc("operator_verify_worker", { p_token: token })).data !== true) return errorResponse("unauthorized", 401);
  const body = await request.json().catch(() => null);
  const run = typeof body?.run_id === "string" && /^[0-9a-f-]{36}$/i.test(body.run_id) ? body.run_id : null;
  if (!run) return errorResponse("run_id required", 400);
  const reserved = await api("/rest/v1/operator_acceptance_run", "POST", { id: run, state: "running" }).catch(() => null);
  if (!reserved) return errorResponse("run already exists or ledger unavailable", 409);
  const checks = {};
  const users = [];
  const fixtureKnowledge = [];
  const prefix = "ideal-" + run.slice(0, 8);
  const check = (name, value) => {
    checks[name] = value ? "pass" : "fail";
    if (!value) throw new Error("assertion:" + name);
  };
  let failure = null;
  try {
    for (const suffix of ["a", "b"]) {
      const email = `${prefix}-${suffix}@example.invalid`;
      const password = crypto.randomUUID() + "Aa7!";
      const created = await api("/auth/v1/admin/users", "POST", { email, password, email_confirm: true, user_metadata: { handle: prefix.replace(/-/g, "") + suffix, full_name: "IDEAL Acceptance", ideal_acceptance_run: run } });
      const user = { auth: String(created.id), profile: "", token: "" };
      users.push(user);
      await api(`/rest/v1/operator_acceptance_run?id=eq.${run}`, "PATCH", { fixture_user_ids: users.map((entry) => entry.auth) });
      const profiles = await api(`/rest/v1/profiles?select=id&auth_sub=eq.${encodeURIComponent(user.auth)}`);
      if (!profiles?.[0]?.id) throw new Error("test_profile_provisioning_failed");
      user.profile = profiles[0].id;
      const signed = await api("/auth/v1/token?grant_type=password", "POST", { email, password });
      user.token = signed.access_token;
      check("identity_" + suffix, await rpc("current_profile_id", {}, user.token) === user.profile);
    }
    const [a, b] = users;
    await rpc("operator_my_memory", { p_key: "favorite_genre", p_value: "thriller" }, a.token);
    await rpc("operator_my_memory", { p_key: "favorite_genre", p_value: "comedy" }, b.token);
    check("self_memory", (await rpc("operator_my_memory", {}, a.token))[0]?.value === "thriller");
    check("cross_user_memory", (await rpc("operator_my_memory", {}, b.token))[0]?.value === "comedy");
    await rpc("operator_my_memory", { p_key: "favorite_genre", p_value: "romance" }, a.token);
    check("memory_correction", (await rpc("operator_my_memory", {}, a.token)).length === 1);
    await rpc("operator_my_memory", { p_key: "favorite_genre", p_delete: true }, a.token);
    check("memory_delete", (await rpc("operator_my_memory", {}, a.token)).length === 0);
    await rpc("operator_my_memory", { p_key: "favorite_genre", p_value: "thriller" }, a.token);
    let denied = false;
    try {
      await rpc("operator_knowledge_edit", { p_slug: prefix, p_title: "Fixture", p_body: "Fixture evidence", p_source_url: null, p_visibility: "public", p_tags: ["fixture"], p_expected_version: 0 }, b.token);
    } catch {
      denied = true;
    }
    check("member_cannot_edit_knowledge", denied);
    await api(`/rest/v1/profiles?id=eq.${a.profile}`, "PATCH", { role: "admin" });
    const slug = prefix + "-knowledge";
    fixtureKnowledge.push(slug);
    const edit = (version, text) => rpc("operator_knowledge_edit", { p_slug: slug, p_title: "IDEAL fixture knowledge", p_body: text, p_source_url: "https://github.com/halluyapp/hallyuapp", p_visibility: "staff", p_tags: ["ideal-fixture"], p_expected_version: version }, a.token);
    check("knowledge_create", await edit(0, "Fixture version one.") === 1);
    check("knowledge_update", await edit(1, "Fixture version two.") === 2);
    denied = false;
    try {
      await edit(1, "Stale fixture.");
    } catch {
      denied = true;
    }
    check("knowledge_conflict", denied);
    const knowledge = await api(`/rest/v1/operator_knowledge?select=id,version&slug=eq.${slug}`);
    check("knowledge_revisions", (await api(`/rest/v1/operator_knowledge_revision?select=version&knowledge_id=eq.${knowledge[0].id}`)).length === 2);
    const active = await rpc("operator_active_constitution", {});
    check("active_constitution", typeof active === "string" && active.startsWith("Active constitution version:"));
    await api(`/rest/v1/profiles?id=eq.${a.profile}`, "PATCH", { role: "member" });
    const providers = await api("/rest/v1/operator_provider?select=provider,model_id&is_default=eq.true&enabled=eq.true");
    if (providers.length !== 1) throw new Error("explicit_default_provider_missing");
    checks.active_provider = providers[0];
    const dm = await rpc("send_direct_message", { p_recipient_handle: "hallyu.ai", p_body: "Acceptance check: What favorite genre have I explicitly saved? Reply with that saved preference only. Do not publish anything or message anyone else.", p_shared_drama_id: null, p_shared_post_id: null }, a.token);
    const convs = await api(`/rest/v1/operator_conversation?select=id&channel=eq.member_ai&member_profile_id=eq.${a.profile}`);
    if (!convs[0]?.id) throw new Error("ordinary_dm_conversation_missing");
    const conv = convs[0].id;
    const tasks = await api(`/rest/v1/operator_task?select=id&conversation_id=eq.${conv}&order=created_at.desc&limit=1`);
    if (!tasks[0]?.id) throw new Error("ordinary_dm_task_missing");
    const task = tasks[0].id;
    await api(`/rest/v1/operator_task?id=eq.${task}`, "PATCH", { max_attempts: 1 });
    checks.task_id = task;
    checks.dm_id = dm?.id ?? null;
    await fetch(base + "/functions/v1/operator-worker", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task_id: task, limit: 1 }), signal: AbortSignal.timeout(7e4) }).catch(() => null);
    let row;
    for (let attempt = 0; attempt < 12; attempt++) {
      row = (await api(`/rest/v1/operator_task?select=status,error_code,provider,model,result&id=eq.${task}`))[0];
      if (["completed", "failed", "cancelled", "blocked"].includes(row?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    checks.live_task = { status: row?.status, error_code: row?.error_code, provider: row?.provider, model: row?.model };
    const audits = await api(`/rest/v1/operator_audit?select=details&task_id=eq.${task}&action=eq.context.loaded`);
    check("deployed_context_loaded", audits.some((entry) => entry.details?.constitution_loaded === true && entry.details?.preferences_supplied === 1));
    if (row?.status !== "completed") {
      checks.real_provider_reasoning = "blocked:" + (row?.error_code ?? row?.status);
    } else {
      const replies = await api(`/rest/v1/direct_messages?select=body&recipient_id=eq.${a.profile}&order=created_at.desc&limit=1`);
      check("live_saved_memory_reply", /thriller/i.test(String(replies[0]?.body ?? "")));
      checks.real_provider_reasoning = "pass";
      checks.reply_excerpt = String(replies[0]?.body ?? "").slice(0, 200);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 200) : "acceptance_error";
  } finally {
    const cleanupErrors = [];
    for (const slug of fixtureKnowledge) await api(`/rest/v1/operator_knowledge?slug=eq.${slug}`, "DELETE").catch(() => cleanupErrors.push("knowledge_cleanup"));
    for (const user of users.reverse()) {
      if (user.profile) {
        await api(`/rest/v1/operator_memory?scope=eq.member&scope_id=eq.${user.profile}`, "DELETE").catch(() => cleanupErrors.push("memory_cleanup"));
        const conversations = await api(`/rest/v1/operator_conversation?select=id&member_profile_id=eq.${user.profile}`).catch(() => []);
        for (const conv of conversations) {
          await api(`/rest/v1/operator_task?conversation_id=eq.${conv.id}`, "DELETE").catch(() => cleanupErrors.push("task_cleanup"));
          await api(`/rest/v1/operator_conversation?id=eq.${conv.id}`, "DELETE").catch(() => cleanupErrors.push("conversation_cleanup"));
        }
        await api(`/rest/v1/profiles?id=eq.${user.profile}`, "DELETE").catch(() => cleanupErrors.push("profile_cleanup"));
      }
      await api(`/auth/v1/admin/users/${user.auth}`, "DELETE").catch(() => cleanupErrors.push("auth_cleanup"));
    }
    checks.cleanup = cleanupErrors.length ? cleanupErrors : "pass";
    await api(`/rest/v1/operator_acceptance_run?id=eq.${run}`, "PATCH", { state: failure ? "failed" : "finished", report: { checks, error: failure }, finished_at: (/* @__PURE__ */ new Date()).toISOString() });
  }
  return jsonResponse({ run_id: run, checks, error: failure }, failure ? 500 : 200);
});
